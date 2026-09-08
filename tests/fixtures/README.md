# Test fixtures

## `dhan-scrip-master-detailed.sample.csv`

- **Derived from:** `https://images.dhan.co/api-data/api-scrip-master-detailed.csv`
  (the live DhanHQ detailed scrip master, also reachable via the fallback layout
  `https://images.dhan.co/api-data/api-scrip-master.csv`).
- **Captured on:** 2026-09-08.
- **What it is:** a **TRIMMED SAMPLE**, not a live snapshot. The real master is
  ~201,075 rows; this file is 14 data rows. The **header row is the exact upstream
  header** (32 columns) so the header-driven parser in
  `src/brokers/dhan/instruments.ts` maps every column by name exactly as it does in
  production.
- **Why these rows:** the set is chosen to exercise the parser and the F&O board join
  end to end, using real values copied verbatim from the live master:
  - `NIFTY` **index** spot (`INDEX`, security id 13)
  - `RELIANCE` and `ARE&M` **equity** spots (`EQ`)
  - `NIFTY` and `RELIANCE` **NFO futures** (`FUT`), pointing at their underlyings
  - `NIFTY` and `RELIANCE` **NFO options** — both **CE and PE** legs, so a strike
    ladder resolves
  - a BSE currency future (`FUTCUR`) to keep a non-NFO derivative present
  - one NSE **TEST scrip** (`01INSETEST`) so the test-symbol filter is exercised (it is
    expected to be skipped, leaving 14 parsed instruments)

  It is **not** invented data: every row was pulled from the live master and only the
  set was trimmed. If Dhan changes the master's column layout, re-capture the header and
  a fresh representative slice rather than editing columns by hand.

- **Consumed by:** `tests/helpers/hermeticNetwork.mjs`, which serves this file whenever
  the code under test fetches the Dhan scrip master URL, so tests never contact
  images.dhan.co. See `tests/README.md` > "Hermetic network".
