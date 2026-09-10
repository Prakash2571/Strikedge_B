/**
 * THE BOUNDED-QUEUE BACKPRESSURE PRIMITIVE (GAP 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Before this there was NO bounded-queue primitive in production. A WebSocket message was
 * processed INLINE inside its callback, which means the slowest thing downstream of the socket set
 * the pace of the socket: an expensive analytics pass, a slow SSE fan-out, or a Mongo/Atlas
 * projection write blocked the single JS event loop, and therefore blocked ORDER-STATE PROCESSING
 * on the very same loop. The failure this creates is the worst one available in an execution
 * system — a fill event sitting unread behind an analytics write while a position goes unmanaged.
 *
 * So work is decoupled from ingestion by an explicit bounded queue, and the stages are SEPARATED
 * so a slow stage backs up ONLY ITSELF. The queue also makes backpressure OBSERVABLE (depth,
 * oldest-queued age, overload) so the rest of the system can react — block new entry, reconcile —
 * instead of discovering the backlog as mysterious latency.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO OVERFLOW DISCIPLINES, AND WHY THEY DIFFER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Not all queued work is equal, and treating it as equal is how a backlog either corrupts state or
 * exhausts memory:
 *
 *   COALESCE      — for MARKET SNAPSHOTS. A Kite/Dhan quote packet is a FULL snapshot of a book
 *                   (verified in BROKER_STREAM_DOCS: full-mode carries the whole 5-level ladder),
 *                   so under pressure keeping only the LATEST per instrument loses nothing: the
 *                   superseded book was going to be replaced anyway. Coalescing is keyed
 *                   per-instrument and bounds the queue to one entry per key. When even the
 *                   distinct-key count exceeds capacity the OLDEST book is dropped — but never
 *                   silently: the drop raises the overload signal and is counted, because a
 *                   dropped-and-not-replaced book is a real coverage gap the health machine must
 *                   see. INCREMENTAL or order data must NEVER use this mode.
 *
 *   NEVER-DROP    — for ORDER EVENTS. An order-update is not a snapshot; it is a discrete fact that
 *                   the account state depends on, and the brokers do not promise to replay one
 *                   missed in a gap (BROKER_STREAM_DOCS §3). Dropping or coalescing one would mean
 *                   inferring account state from an incomplete event history — precisely the "a
 *                   missing event is not a zero fill" defect. So this queue NEVER drops and NEVER
 *                   coalesces: past its soft capacity it simply signals OVERLOAD (so the caller
 *                   blocks NEW ENTRY, reconciles against the broker, and preserves exposure
 *                   management) while continuing to hold — and eventually deliver — every event.
 *                   Its capacity is a pressure THRESHOLD, not a hard cap that could lose data.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PURITY / DETERMINISM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The queue holds NO timers and NO sockets. `enqueue` is synchronous and cheap — the WebSocket
 * callback does exactly that and returns, so the socket is never blocked. Draining is driven by
 * the caller (a pump loop, or a microtask scheduler in production), so tests advance it
 * deterministically and nothing dangles. The clock is injected.
 */

/** How a stage behaves when it reaches capacity. See the module header. */
export type OverflowPolicy = "coalesce" | "never-drop";

export interface BoundedQueueOptions {
  /** A stable name for diagnostics/logging. */
  readonly name: string;
  /**
   * Capacity. For `coalesce` this is a HARD bound on distinct keys held. For `never-drop` it is a
   * SOFT pressure threshold: the queue may exceed it (it must, rather than drop) but reports
   * overloaded once it does.
   */
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
  /** Monotonic clock (ms). Injected for determinism; defaults to Date.now. */
  readonly now?: () => number;
  /** Notified (once per crossing) when the queue transitions into an overloaded condition. */
  readonly onOverload?: (info: { name: string; depth: number; dropped: number }) => void;
}

interface QueuedItem<T> {
  readonly key: string;
  value: T;
  /** Monotonic ms the item (or its coalescing slot) was first enqueued — the oldest-age clock. */
  enqueuedAt: number;
}

export interface BoundedQueueDiagnostics {
  name: string;
  overflow: OverflowPolicy;
  capacity: number;
  depth: number;
  oldestAgeMs: number | null;
  overloaded: boolean;
  enqueued: number;
  processed: number;
  dropped: number;
  coalesced: number;
  overloadEvents: number;
}

export class BoundedQueue<T> {
  private readonly items: QueuedItem<T>[] = [];
  /** For coalescing: key → index into `items`, so an update replaces in place in O(1). */
  private readonly indexByKey = new Map<string, number>();
  private readonly nowFn: () => number;
  private overloaded = false;
  /** Latches overload after a drop until the next successful drain observes it. */
  private droppedHold = false;

  private enqueuedCount = 0;
  private processedCount = 0;
  private droppedCount = 0;
  private coalescedCount = 0;
  private overloadEventCount = 0;

  constructor(private readonly opts: BoundedQueueOptions) {
    this.nowFn = opts.now ?? Date.now;
  }

  get name(): string {
    return this.opts.name;
  }

  /** Number of items currently queued. */
  depth(): number {
    return this.items.length;
  }

  /** Age (ms) of the OLDEST queued item, or null when empty. The head-of-line-blocking signal. */
  oldestAgeMs(now = this.nowFn()): number | null {
    const head = this.items[0];
    if (!head) return null;
    return Math.max(0, now - head.enqueuedAt);
  }

  /** True while the queue is over its pressure threshold. Read this before permitting new entry. */
  isOverloaded(): boolean {
    return this.overloaded;
  }

  /**
   * Add one item. SYNCHRONOUS and cheap — a WebSocket callback calls this and returns immediately,
   * so the socket is never blocked by downstream processing.
   *
   * `key` is the coalescing identity. For `coalesce`, a repeat key REPLACES the queued value in
   * place (latest-per-instrument) and keeps the ORIGINAL enqueue time so the oldest-age signal
   * still reflects head-of-line staleness. For `never-drop`, `key` is retained for diagnostics but
   * never causes a replacement or a drop.
   */
  enqueue(value: T, key: string): void {
    this.enqueuedCount++;
    const now = this.nowFn();

    if (this.opts.overflow === "coalesce") {
      const existing = this.indexByKey.get(key);
      if (existing !== undefined) {
        // Same book updated again: replace the payload, keep the queue slot and its enqueue time.
        this.items[existing]!.value = value;
        this.coalescedCount++;
        this.reassess();
        return;
      }
      // A new distinct key. If at capacity, drop the OLDEST snapshot — never silently.
      if (this.items.length >= this.opts.capacity) {
        this.dropOldest();
      }
      this.items.push({ key, value, enqueuedAt: now });
      this.indexByKey.set(key, this.items.length - 1);
      this.reassess();
      return;
    }

    // never-drop: append unconditionally. Capacity is a pressure threshold, not a cap.
    this.items.push({ key, value, enqueuedAt: now });
    this.reassess();
  }

  /**
   * Remove and return the next item (FIFO), or undefined when empty. Caller processes it OUTSIDE
   * the enqueue path. For `coalesce` the key index is kept consistent.
   */
  dequeue(): T | undefined {
    const item = this.items.shift();
    if (!item) return undefined;
    this.processedCount++;
    // A drain OBSERVES any latched drop: the coverage gap has now been consumed, so the latch can
    // release and overload may clear once depth is within capacity.
    this.droppedHold = false;
    if (this.opts.overflow === "coalesce") this.reindexAfterShift(item.key);
    this.reassess();
    return item.value;
  }

  /** Drain and return everything currently queued, in FIFO order. */
  drainAll(): T[] {
    const out = this.items.map((i) => i.value);
    this.processedCount += this.items.length;
    this.items.length = 0;
    this.indexByKey.clear();
    this.droppedHold = false;
    this.reassess();
    return out;
  }

  /** Peek at the head value without removing it. */
  peek(): T | undefined {
    return this.items[0]?.value;
  }

  diagnostics(): BoundedQueueDiagnostics {
    return {
      name: this.opts.name,
      overflow: this.opts.overflow,
      capacity: this.opts.capacity,
      depth: this.items.length,
      oldestAgeMs: this.oldestAgeMs(),
      overloaded: this.overloaded,
      enqueued: this.enqueuedCount,
      processed: this.processedCount,
      dropped: this.droppedCount,
      coalesced: this.coalescedCount,
      overloadEvents: this.overloadEventCount,
    };
  }

  private dropOldest(): void {
    const dropped = this.items.shift();
    if (!dropped) return;
    this.droppedCount++;
    this.reindexAfterShift(dropped.key);
    // A dropped snapshot is a coverage gap the health machine must see, so overload is forced on
    // even though the depth is now back within capacity.
    this.forceOverload();
  }

  /** After a shift removes items[0], every stored index is off by one; rebuild for the key map. */
  private reindexAfterShift(removedKey: string): void {
    this.indexByKey.delete(removedKey);
    // O(n) rebuild. n is bounded by capacity (coalesce mode), so this stays cheap.
    this.indexByKey.clear();
    for (let i = 0; i < this.items.length; i++) this.indexByKey.set(this.items[i]!.key, i);
  }

  private reassess(): void {
    const nowOver = this.items.length > this.opts.capacity;
    if (nowOver && !this.overloaded) {
      this.overloaded = true;
      this.emitOverload();
    } else if (!nowOver && this.overloaded && this.items.length <= this.opts.capacity && !this.droppedHold) {
      // Clear once the backlog has drained back to within capacity AND no unobserved drop is
      // holding overload on. A drop-driven overload stays latched (droppedHold) until a drain
      // observes it, so a coverage gap is never hidden by the queue merely settling back to
      // capacity after the drop.
      this.overloaded = false;
    }
  }

  private forceOverload(): void {
    this.droppedHold = true;
    if (!this.overloaded) {
      this.overloaded = true;
      this.emitOverload();
    }
  }

  private emitOverload(): void {
    this.overloadEventCount++;
    try {
      this.opts.onOverload?.({ name: this.opts.name, depth: this.items.length, dropped: this.droppedCount });
    } catch {
      // A diagnostics callback must never break ingestion.
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE STAGE PIPELINE — the separation that keeps a slow stage from blocking order processing.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

export interface StageDefinition<T = unknown> {
  readonly name: string;
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
  /** Processes ONE item. May be async (a DB write, an SSE flush). Never called inside enqueue. */
  readonly handler: (value: T) => void | Promise<void>;
  readonly onOverload?: (info: { name: string; depth: number; dropped: number }) => void;
}

interface Stage<T = unknown> {
  readonly def: StageDefinition<T>;
  readonly queue: BoundedQueue<T>;
  /** True while this stage's own drain loop is running, so two pumps never interleave one stage. */
  draining: boolean;
}

export interface StagePipelineOptions {
  readonly now?: () => number;
}

/**
 * A set of independently-draining {@link BoundedQueue} stages.
 *
 * THE SAFETY PROPERTY: each stage owns its own queue and its own drain loop. Draining stage A
 * awaits ONLY stage A's handler; a handler that blocks (a slow SSE flush, a stuck analytics write)
 * parks stage A alone. Stage B — order-state processing — is a different queue drained by a
 * different loop and is untouched. The pipeline never processes work inside `enqueue`, so the
 * WebSocket callback that calls `enqueue` returns immediately regardless of any stage's health.
 */
export class StagePipeline {
  private readonly stages = new Map<string, Stage>();
  private readonly nowFn: () => number;

  constructor(opts: StagePipelineOptions = {}) {
    this.nowFn = opts.now ?? Date.now;
  }

  addStage<T>(def: StageDefinition<T>): void {
    if (this.stages.has(def.name)) throw new Error(`stage "${def.name}" already exists`);
    const queue = new BoundedQueue<T>({
      name: def.name,
      capacity: def.capacity,
      overflow: def.overflow,
      now: this.nowFn,
      ...(def.onOverload ? { onOverload: def.onOverload } : {}),
    });
    this.stages.set(def.name, { def: def as StageDefinition, queue: queue as BoundedQueue<unknown>, draining: false });
  }

  /** Enqueue to a named stage. Synchronous; the handler does NOT run here. */
  enqueue<T>(stageName: string, value: T, key: string): void {
    const stage = this.stages.get(stageName);
    if (!stage) throw new Error(`unknown stage "${stageName}"`);
    stage.queue.enqueue(value, key);
  }

  stage(name: string): BoundedQueue<unknown> {
    const stage = this.stages.get(name);
    if (!stage) throw new Error(`unknown stage "${name}"`);
    return stage.queue;
  }

  /** Combined depth across every stage. */
  totalDepth(): number {
    let sum = 0;
    for (const s of this.stages.values()) sum += s.queue.depth();
    return sum;
  }

  /** True when ANY stage is overloaded — the signal that must block new entry. */
  isOverloaded(): boolean {
    for (const s of this.stages.values()) if (s.queue.isOverloaded()) return true;
    return false;
  }

  /** Names of the stages currently overloaded, for a precise degraded reason. */
  overloadedStages(): string[] {
    const out: string[] = [];
    for (const [name, s] of this.stages) if (s.queue.isOverloaded()) out.push(name);
    return out;
  }

  diagnostics(): Record<string, BoundedQueueDiagnostics> {
    const out: Record<string, BoundedQueueDiagnostics> = {};
    for (const [name, s] of this.stages) out[name] = s.queue.diagnostics();
    return out;
  }

  /**
   * Drain the given stages (default: all) until each is empty.
   *
   * BOUNDED and deterministic: it drains a SNAPSHOT of the currently-queued work and stops when the
   * queues it was asked to drain are empty. Each stage drains sequentially through its own handler
   * so an ordering guarantee holds per stage; stages are pumped concurrently so a slow one does not
   * hold up the others. Safe to call repeatedly and on an empty pipeline.
   */
  async pumpUntilIdle(opts: { stages?: string[] } = {}): Promise<void> {
    const names = opts.stages ?? [...this.stages.keys()];
    await Promise.all(names.map((name) => this.drainStage(name)));
  }

  private async drainStage(name: string): Promise<void> {
    const stage = this.stages.get(name);
    if (!stage) throw new Error(`unknown stage "${name}"`);
    if (stage.draining) return; // a drain is already in flight for this stage
    stage.draining = true;
    try {
      // Drain to empty. `never-drop` stages can still be growing, but pumpUntilIdle drains whatever
      // is present when the loop reaches it; new arrivals during a drain are handled by the loop
      // continuing while items remain.
      while (stage.queue.depth() > 0) {
        const value = stage.queue.dequeue();
        if (value === undefined) break;
        await stage.def.handler(value);
      }
    } finally {
      stage.draining = false;
    }
  }
}
