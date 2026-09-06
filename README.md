# grok-pool

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-green.svg)](https://nodejs.org/)

A transparent catch-all proxy and account pool for **Grok Build** (the `grok` CLI). It sits between
the CLI and `https://cli-chat-proxy.grok.com` — the CLI keeps doing everything native (planning, tool
calls, shell, filesystem, subagents, context, sessions), while the pool routes every request across
your OAuth accounts, traces all traffic, and **keeps the Thinking blocks visible**.

```
GROK BUILD ──> grok-pool :20129 ──┬──> account 01 ──┐
             (route / trace /     ├──> account 02 ──┼──> cli-chat-proxy.grok.com
              sticky / health)    └──> account N  ──┘
```

---

## Tutorial: from zero to Thinking

### Step 0 — Requirements

- **Node.js >= 22.12** (uses the built-in `node:sqlite`; no build step, no native deps)
- Grok Build CLI installed and logged in with at least one account
- Optional: [9Router](https://github.com/) running with `grok-cli` accounts (the pool reads them
  read-only straight from its database)

### Step 1 — Run the pool

```bash
git clone https://github.com/phong-jack/grok-build-pool.git
cd grok-build-pool
npm install
cp .env.example .env     # Windows: copy .env.example .env
npm start
```

Expected output:

```
grok-pool v4.0.0 — transparent gateway
  local:     http://127.0.0.1:20129
  upstream:  https://cli-chat-proxy.grok.com (path+query forwarded verbatim)
  accounts:  N total / N usable
  dashboard: http://127.0.0.1:20129/dashboard
```

### Step 2 — Load accounts

The pool merges accounts from up to three sources (all optional, combined automatically):

**a) 9Router database (default).** Set `ROUTER_DB_PATH` in `.env` to 9Router's SQLite file, e.g.:

```
ROUTER_DB_PATH=C:\Users\you\AppData\Roaming\9router\db\data.sqlite
```

All `grok-cli` accounts join the pool. The database is opened **read-only** — 9Router stays the
single writer, and account changes there are picked up within 30 seconds.

**b) Paste an account into the dashboard (recommended for your "Thinking" account).**

1. Open <http://127.0.0.1:20129/dashboard> → section **Premium / Thinking accounts**
2. Open `~/.grok/auth.json`, copy the **whole file content**
3. Paste it into the textarea → click **add premium account**
4. The account appears in the table with `has_summaries` — click **check** to verify it live-streams
   reasoning summaries (result: `THINKING` or `NO`)

This writes `data/accounts.extra.json`. You can also edit that file directly:

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

(`key` → `accessToken`, `refresh_token` → `refreshToken`, `user_id` → `userId`.)

**c) Login importer.** `npm run login -- <name>` runs a real `grok login` in an isolated `GROK_HOME`
and imports the account into 9Router's DB. Use this to add accounts you own with email+password.

### Step 3 — Verify which accounts have Thinking

Upstream only streams reasoning summaries for **certain accounts** (decided server-side per account;
see [Why Thinking can disappear](#why-thinking-can-disappear)). Find out which of yours qualify:

```bash
npm run check-thinking
```

Output:

```
01   you@gmail.com          THINKING
02   someone@l0z.org        200 completed
...
```

`THINKING` = the account streams summaries and will show the "Thought for Xs" block in the TUI.
Make sure every `THINKING` account is flagged `"premium": true` (the dashboard does this
automatically when you paste auth.json).

### Step 4 — Point Grok Build at the pool

**Option A — environment variable (no config changes):**

```powershell
$env:GROK_CLI_CHAT_PROXY_BASE_URL = "http://127.0.0.1:20129/v1"
grok
```

**Option B — if `~/.grok/config.toml` has a custom `[model."..."]` with `base_url`** (e.g. pointing
at 9Router): that entry **overrides** the env var. Either edit its `base_url` to
`http://127.0.0.1:20129/v1`, or run Grok Build with a dedicated `GROK_HOME` containing a copy of
`~/.grok/auth.json` but **no** `config.toml` (sessions live inside `GROK_HOME`, so `grok --continue`
needs the same home).

Back to normal: close the terminal, or restore `base_url`.

### Step 5 — Use Grok Build normally

Prompt it, let it think, run tools, edit files. Meanwhile:

- **Dashboard** (`/dashboard`): live account health (ACTIVE / RATE_LIMITED / …), request inspector
  (method, path, serving account, latency, attempts, errors), premium management section
- **Routing**: `premium-first` (default recommendation) serves every inference from your
  thinking-capable accounts; the rest rotate as backup. `round-robin` | `least-used` | `random`
  available via `POOL_STRATEGY`
- **Resilience**: 429 → cooldown + automatic failover before the first response byte; expired access
  tokens refresh themselves (your refresh token is the only thing that matters long-term)

### Step 6 — Hygiene

```bash
npm run export-accounts   # sync the freshest tokens from pool.db into data/accounts.extra.json
```

OAuth refresh rotates refresh tokens — the newest ones live in `data/pool.db`. Run the export before
deleting `pool.db`, cloning the setup to another machine, or occasionally for hygiene. Guard both
files: **they contain your credentials** (gitignored).

---

## Why Thinking can disappear

(Investigated via the public Grok Build Rust source plus live wire captures.)

- Thinking text renders only from SSE `response.reasoning_summary_text.delta` events — upstream
  decides **per account** whether to send them. Fresh, cleanly-used accounts typically get summaries;
  accounts with a heavy automation history usually don't. It is not the tier in `/v1/user` (always
  `null`), not the model, and not the proxy.
- `/v1/user` always reports `subscriptionTier: null`, so the CLI treats the session as Free and shows
  a `[Click here to Upgrade]` tip. The pool patches **that one field**
  (`GROK_POOL_SUBSCRIPTION_TIER=SuperGrok`; empty disables).
- The client cannot request summaries by changing the body (`reasoning.summary` is hardcoded
  `concise`, no effort parameter affects it) — verified against the official source.

**If Thinking disappears mid-run**: check `/pool/premium` → `has_summaries` column, or run
`npm run check-thinking`. If your premium account stopped streaming summaries, add a fresh account
(`grok login` → paste auth.json). The auto-premium probe (`AUTO_PREMIUM_PROBE=true`, default) also
continuously watches accounts and promotes/demotes them automatically.

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `20129` / `127.0.0.1` | Pool listen address |
| `UPSTREAM_ORIGIN` | `https://cli-chat-proxy.grok.com` | Path+query forwarded verbatim onto this origin |
| `ROUTER_DB_PATH` | 9Router default path | 9Router SQLite, opened read-only |
| `POOL_DB_PATH` | `./data/pool.db` | Pool state (health, sticky, requests, token overrides) |
| `ACCOUNTS_EXTRA_JSON` | `./data/accounts.extra.json` | Extra accounts file |
| `POOL_STRATEGY` | `round-robin` | `premium-first` \| `round-robin` \| `least-used` \| `random` |
| `MAX_FAILOVERS` | `4` | Extra upstream attempts per request (before first byte only) |
| `GROK_TRACE` | `info` | `info` \| `debug` \| `wire` (wire dumps headers/bodies/SSE per request) |
| `GROK_POOL_SUBSCRIPTION_TIER` | `SuperGrok` | Patches `/v1/user` tier (removes the Free banner); empty disables |
| `AUTO_PREMIUM_PROBE` | `true` | Watch accounts and auto promote/demote summary capability |
| `POOL_API_KEY` | empty | If set, proxied requests must send it as their bearer |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Upstream request timeout |
| `HEALTH_PROBE_INTERVAL_MS` | `600000` | Health + premium probe cycle |

## Admin API

All under the pool origin, local-only by default:

```
GET    /pool/health                     overall status
GET    /pool/accounts?refresh=1         account list (statuses, has_summaries)
GET    /pool/requests?limit=100         request history
GET    /pool/stats                      totals
GET    /pool/premium                    premium management list
POST   /pool/premium                    add account  {"auth": <auth.json or entry>}
DELETE /pool/premium/<id-or-email>      remove account
POST   /pool/premium/check/<email>      live reasoning-summary probe
POST   /pool/export-accounts            sync freshest tokens into the extra file
GET    /pool/config                     current config
POST   /pool/config                     {"trace": {"level": "wire", ...}}
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| No Thinking block in the TUI | `npm run check-thinking` — is any account `THINKING`? Flag it premium (`premium-first`). If your only premium stopped: add a fresh account via dashboard |
| `[Click here to Upgrade]` banner | Cosmetic tip injected by upstream; the pool's tier patch should hide the Free classification — see `GROK_POOL_SUBSCRIPTION_TIER` |
| All requests 429 | Your accounts hit upstream rate limits. The pool cools them down and rotates — add more accounts or slow down |
| One account shows AUTH_FAILED | Its refresh token is revoked: log in again (`grok login`), update the entry (dashboard or file) |
| Port 20129 busy | Another pool/v3 instance is running — kill it or change `PORT` |
| Requests work but grok doesn't use the pool | A custom `[model."..."]` `base_url` in `config.toml` overrides the env var — see Step 4 Option B |
| Need to see exactly what flows | `GROK_TRACE=wire` (or POST `/pool/config` live) → per-request dumps under `traces/wire/` |

## How it works

- Raw `node:http/https` both directions: bodies are buffered raw bytes and replayed untouched,
  responses (including SSE) are piped byte-exact, headers are copied both ways minus hop-by-hop. No
  fetch/undici/express in the request path.
- Request bodies are peeked (read-only) for routing signals: `previous_response_id`, model, stream,
  session ids (`x-grok-*` headers + `/v1/sessions/<uuid>` path segments).
- Sticky index maps `previous_response_id` / session ids → account; failover replays the buffered
  body against the next account **strictly before the first response byte**.
- Pool state (health counters, sticky bindings, request history, refreshed tokens) lives in
  `data/pool.db` (built-in `node:sqlite`). Credentials stay in 9Router's DB (read-only) and your
  extra accounts file.

## License

[MIT](LICENSE). Use with **your own accounts** — don't share tokens, and weigh xAI's terms of
service yourself when pooling many accounts.
