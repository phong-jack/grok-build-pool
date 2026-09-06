# grok-pool v4 — transparent gateway for Grok Build

Catch-all reverse proxy + account pool sitting between **Grok Build** (the `grok` CLI)
and `https://cli-chat-proxy.grok.com`. The CLI keeps doing everything native
(planning, tool calls, shell, filesystem, subagents, context, sessions) — the pool
is a pure gateway that routes, traces, and pools 29 OAuth accounts.

```text
GROK BUILD ──> grok-pool :20129 ──┬──> account 01 ──┐
             (trace / route /      ├──> account 02 ──┼──> cli-chat-proxy.grok.com
              sticky / health)     └──> ... 29   ───┘
```

## Design rules (v4)

1. **Catch-all**: no endpoint whitelist. Any method, any path, any query — forwarded.
2. **Protocol preservation**: bodies are buffered raw bytes and re-sent untouched;
   responses (including SSE) are piped byte-identical; headers pass both ways
   (hop-by-hop filtered). No Responses→Chat translation, no stream→JSON.
3. **The pool only overrides identity**: `Authorization` and the account-scoped
   headers (`x-grok-user-id`, `x-email`), and fills missing `x-grok-*` headers for
   non-Grok clients. Everything the client sent wins.
4. **Trace everything**: every request/response lands in console +
   `traces/requests.ndjson` (INFO/DEBUG/WIRE levels), secrets redacted.
5. **Retry only before the first byte**: failover happens on retryable statuses
   (401/403/408/409/429/5xx, timeouts, resets) before streaming starts; a 400/404
   is passed straight through; mid-stream errors are never replayed.

## Quick start

```powershell
npm install
npm start

# point Grok Build at the pool (base_url style)
$env:GROK_CLI_CHAT_PROXY_BASE_URL = "http://127.0.0.1:20129/v1"
grok
```

Dashboard: <http://127.0.0.1:20129/dashboard>

## Routing

- **INFERENCE** (`/v1/responses`, `/v1/chat/completions`, `/v1/messages`, …):
  sticky by `previous_response_id` → `x-grok-conv-id` / `x-grok-session-id`,
  otherwise the configured strategy (`round-robin` | `least-used` | `random`)
  over ACTIVE accounts. Response ids observed in the SSE stream are bound to the
  account that produced them.
- **METADATA** (`/v1/settings`, `/v1/models*`, `/v1/subagents/*`, GETs): same
  sticky resolution when a session is known, otherwise strategy.

Account health: `ACTIVE / COOLDOWN / RATE_LIMITED (Retry-After aware) /
DEGRADED / DEAD / AUTH_FAILED`. Success heals; 401 triggers one OAuth token
refresh (via `auth.x.ai` discovery, `client_id=grok-cli`) then a same-account
retry; refreshed tokens are persisted as overrides in `pool.db` — the 9Router DB
stays read-only.

## Layout

```
src/
  index.js        bootstrap (wire ctx, token overrides, listen)
  server.js       catch-all HTTP server, dashboard + /pool/* admin routes
  proxy.js        failover loop, body buffering, stream tap, sticky binding
  forward.js      raw node:http(s) transport, hop-by-hop header filters
  classify.js     read-only request peek (METADATA/INFERENCE/UNKNOWN)
  identity.js     upstream header build (client wins; identity swapped)
  trace/          INFO|DEBUG|WIRE engine, redaction, ndjson sink
  pool/           pool.js (strategies) sticky.js health.js
  accounts/       source.js (9Router SQLite, read-only) refresh.js (OAuth)
  store/db.js     pool.db: accounts_state, sessions, requests
dashboard/        vanilla static UI (polls /pool/*)
tests/            mock upstream + golden tests (node --test)
docs/grok-build-api.md    endpoint inventory from live discovery
scripts/smoke.js  health-check a running pool
```

## Env

See `.env.example`. Key ones: `UPSTREAM_ORIGIN` (path+query appended verbatim),
`ROUTER_DB_PATH` (credentials source), `POOL_STRATEGY`, `MAX_FAILOVERS`,
`GROK_TRACE=info|debug|wire` (`wire` also dumps headers/bodies/SSE per request
under `traces/wire/<id>/` — reverse-engineering mode), `POOL_API_KEY` (optional
client gate).

## Tests

```powershell
npm test        # golden tests against a scriptable mock upstream
npm run smoke   # checks against a running pool
npm run smoke -- --upstream   # + one real GET /v1/models through the pool
```

Account import (adds one account via real `grok login` in an isolated
`GROK_HOME`, writes it into the 9Router DB):

```powershell
npm run login -- myaccount
npm run accounts
```
