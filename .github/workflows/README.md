# CI workflows

`ci.yml` is the StrikeEdge backend pipeline. It runs on every push to `main` and every pull
request, with a read-only token and no repository secrets.

## What it guarantees

1. **Deterministic install** — strict `npm ci` (no `npm install` fallback) plus a lockfile-in-sync
   check, so a stale `package-lock.json` fails the build instead of being silently rewritten.
2. **Build / typecheck** — `npm run build` (which is `tsc -b`, also the typecheck) and an assertion
   that `dist/index.js` was actually emitted.
3. **All seven suites against REAL databases** — PostgreSQL (`postgres:17.2-alpine`) and MongoDB
   (`mongo:7.0.14`) run as pinned service containers, health-checked and then re-probed from inside
   the job before any test runs. Suites run in order: `test:unit`, `test:pg`, `test:projector`,
   `test:tokens`, `test:switch`, `test:access`, `test:shutdown`.
4. **No silent skips** — each suite's output is captured, and a dedicated step fails the build if
   any database-dependent suite (`pg`, `projector`, `tokens`, `switch`, `access`) reports a non-zero
   `skipped` count or no summary line at all. A test that starts skipping because a database went
   missing turns the build **red**, not green.
5. **Safety defaults** — asserts `.env.example` never sets `BOX_EXECUTION_MODE=live` or
   `BOX_LIVE_TRADING_ENABLED=true`.
6. **No committed secrets** — greps the tracked tree for `.env` / credential / key files (allowing
   only the `.env.example` template).

## No secrets, no broker

The token suite drives a local mock HTTP server on `127.0.0.1`; nothing in CI contacts
`calspread.online` or any real broker. Every secret referenced (`SITE_ACCESS_SECRET`,
`BROKER_TOKEN_ENCRYPTION_KEY`) is an obviously fake, inline test value.

## Pinned versions

| Component  | Pin                    |
| ---------- | ---------------------- |
| Node       | `22.23.2`              |
| npm        | `11.4.2`               |
| PostgreSQL | `postgres:17.2-alpine` |
| MongoDB    | `mongo:7.0.14`         |

## Cross-dependency

The `safety-defaults` job reads `.env.example`, which is authored by a separate agent. If that file
has not landed yet, the job fails by design — a runnable backend without a safe example config is
itself worth flagging.
