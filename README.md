# grok-pool

A transparent catch-all proxy and account pool for **Grok Build** (the `grok` CLI). It sits between
the CLI and `https://cli-chat-proxy.grok.com` — the CLI keeps doing everything native (planning, tool
calls, shell, filesystem, subagents, context, sessions), while the pool routes every request across
your OAuth accounts, traces all traffic, and **keeps the Thinking blocks visible**.

```
GROK BUILD ──> grok-pool :20129 ──┬──> account 01 ──┐
             (route / trace /     ├──> account 02 ──┼──> cli-chat-proxy.grok.com
              sticky / health)    └──> account N  ──┘
```

## Why

- You manage **multiple Grok accounts** (e.g. via [9Router](https://github.com/) device-code logins)
  and want one Grok Build to use them all — when one is rate-limited, requests fail over to the rest
  automatically.
- You want **Thinking** (reasoning summaries) to keep rendering in the TUI. Upstream only streams
  summaries for *some* accounts — the pool lets you pin those with a `premium-first` strategy.
  See [Keeping Thinking alive](#keeping-thinking-alive).
- You want to see **every request** the CLI makes: endpoints, serving account, latency, SSE events,
  errors — with a realtime dashboard.

## Requirements

- **Node.js >= 22.12** (uses the built-in `node:sqlite`; no build step)
- Grok Build CLI installed and logged in with at least one account
- Optional: [9Router](https://github.com/) running with `grok-cli` accounts — the pool reads them
  directly from its database

## Quick start

```bash
git clone https://github.com/phong-jack/grok-build-pool.git
cd grok-build-pool
npm install
cp .env.example .env   # adjust ROUTER_DB_PATH if your 9Router lives elsewhere
npm start
```

The pool listens on `http://127.0.0.1:20129` — dashboard at
<http://127.0.0.1:20129/dashboard>.

## Pointing Grok Build at the pool

**Option A — environment variable (no config changes):**

```powershell
$env:GROK_CLI_CHAT_PROXY_BASE_URL = "http://127.0.0.1:20129/v1"
grok
```

**Option B — if your `~/.grok/config.toml` defines a custom `[model."..."]` with a `base_url`**
(e.g. pointing at 9Router): that entry **overrides** the env var. Either edit its `base_url` to
`http://127.0.0.1:20129/v1`, or run Grok Build with a dedicated `GROK_HOME` containing a copy of
`~/.grok/auth.json` but **no** `config.toml`. Note that sessions are stored inside `GROK_HOME`, so
`grok --continue` must run from the same home.

To go back to normal, just close the terminal (env vars are not persistent) or restore `base_url`.

## Accounts

The pool merges accounts from two sources:

| Source | Configuration | Notes |
|---|---|---|
| **9Router** (default) | `ROUTER_DB_PATH` pointing at 9Router's SQLite (e.g. `C:\Users\you\AppData\Roaming\9router\db\data.sqlite`) | Opened **read-only** — 9Router stays the single writer. All `grok-cli` accounts in it join the pool |
| **Extra accounts file** | `data/accounts.extra.json` (format below) | For accounts outside 9Router — e.g. your "thinking-capable" account |
| **Login importer** | `npm run login -- <name>` — runs a real `grok login` in an isolated `GROK_HOME` and imports the result into 9Router's DB | Interactive browser/device flow |

`data/accounts.extra.json` format:

```json
[
  {
    "email": "you@gmail.com",
    "userId": "user-uuid-from-auth.json",
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "expiresAt": "2026-09-06T15:57:05Z",
    "premium": true
  }
]
```

Take the fields from `~/.grok/auth.json` (key `https://auth.x.ai::...`): `key` → `accessToken`,
`refresh_token` → `refreshToken`, `user_id` → `userId`. When the access token expires the pool
**refreshes it automatically** (OIDC discovery against `auth.x.ai`), so an account with a refresh
token stays operational indefinitely — no manual re-login.

## Keeping Thinking alive

**Key finding:** upstream only streams **reasoning summaries** (what renders as the "Thought for Xs"
block in the TUI) for *certain accounts*. It is decided server-side per account — it is **not** the
tier shown in `/v1/user` (always `null`), it is not model-dependent (`grok-4.5` and `grok-4.6`
behave identically), and it is not caused by proxying (direct calls behave the same). Fresh,
cleanly-used accounts typically get summaries; accounts with a heavy automation history usually
don't.

The pool ships a **`premium-first`** strategy for exactly this:

1. Mark the accounts that still show Thinking: add `"premium": true` in `data/accounts.extra.json`.
2. Set in `.env`:
   ```
   POOL_STRATEGY=premium-first
   ```
3. Every inference now prefers the premium account → Thinking keeps rendering. When the premium
   account is rate-limited or cooling down, requests fail over to the remaining accounts and the
   rotation continues; when it recovers, it takes over again. Conversations never break across the
   switch — reasoning `encrypted_content` is not account-bound (verified in practice).

Physical limit: a turn served by a non-premium account has no thinking text (everything else works
normally). For 100% Thinking plus deeper load sharing, add **several** premium accounts — the pool
rotates among premiums first, then falls to the rest.

## Why Thinking "disappears"

(From investigating the public Grok Build Rust source plus live wire captures.)

- Thinking text renders only from SSE `response.reasoning_summary_text.delta` events — upstream
  decides per account whether to send them.
- `/v1/user` always reports `subscriptionTier: null`, so the CLI treats the session as Free and
  injects a `[Click here to Upgrade]` tip (server-side injected for everyone). The pool patches
  **that one field** (`GROK_POOL_SUBSCRIPTION_TIER=SuperGrok`; set empty to disable) and touches
  nothing else.

## Features

- **Catch-all**: every method, path and query is forwarded — no endpoint whitelist, so new CLI
  endpoints just work
- **Protocol preservation**: raw body bytes, byte-exact SSE piping, two-directional header copying
  (hop-by-hop filtered), no auto-decompression — Grok Build cannot tell it is going through a pool
- **Routing**: `premium-first` | `round-robin` | `least-used` | `random`; sticky routing by
  `previous_response_id` and session UUID (mid-conversation failover never corrupts sessions)
- **Health**: ACTIVE / COOLDOWN / RATE_LIMITED (Retry-After aware) / DEGRADED / DEAD / AUTH_FAILED;
  403 is treated as a short cooldown (usually request-scoped, not a dead account); a periodic prober
  heals accounts automatically
- **Automatic token refresh** via OIDC discovery (`auth.x.ai`); refreshed tokens persist as
  overrides in the pool's own DB — the 9Router database stays read-only
- **Tracing**: `GROK_TRACE=info|debug|wire` — structured ndjson plus per-request wire dumps, secrets
  redacted
- **Realtime dashboard**: per-account status, request inspector (status / latency / attempts / errors)
- **Admin API**: `GET /pool/health|accounts|requests|stats|config`, `POST /pool/config` (live trace
  level changes)

## Testing

```bash
npm test        # golden tests: byte-identical passthrough, sticky routing, failover, no-retry-on-400 (node --test)
npm run smoke   # check a running pool (add --upstream for one real GET /v1/models through the pool)
```

## FAQ

**Does the pool add latency or break anything?** No — bodies pass through as raw bytes and streams
are piped directly, adding only a local hop. Failover happens strictly before the first response
byte, so SSE streams are never interleaved.

**I don't use 9Router.** Remove/ignore `ROUTER_DB_PATH` — the pool starts with zero 9Router
accounts and works entirely off `data/accounts.extra.json`.

**How long do tokens live?** Access tokens last ~6 hours, but the pool refreshes them with the
refresh token — operationally, accounts with a refresh token never expire.

**Disclaimer**: use this with **your own accounts**. Do not share tokens or account files, and weigh
xAI's terms of service yourself when pooling many accounts.

## License

[MIT](LICENSE)
