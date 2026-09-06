# Grok Build — observed API inventory

Endpoint inventory built from **live traffic captured through grok-pool v4**
(trace-all catch-all, Grok CLI 1.0.13 / grok.exe 5e9a58528b76, 2026-09-06).
Nothing here is assumed from documentation; every row is backed by a captured
request in `traces/requests.ndjson` / `traces/wire/`. Status legend:

- `SUPPORTED` — verified flowing through the pool with Grok Build working end-to-end
- `OBSERVED` — seen in traces, behavior not fully exercised
- `UNKNOWN` — referenced somewhere but not yet captured

## Inventory

| METHOD | PATH | PURPOSE | AUTH | STREAM | ACCOUNT STICKY | STATUS |
|---|---|---|---|---|---|---|
| GET | `/v1/models` | model list (CLI caches in `models_cache.json`) | bearer | no | no | SUPPORTED |
| GET | `/v1/settings` | fleet/telemetry policy (CLI polls it repeatedly) | bearer | no | no | SUPPORTED |
| GET | `/v1/user?include=subscription` | account + subscription status (heartbeat ~60s) | bearer | no | no | SUPPORTED |
| GET | `/v1/billing` (+`?format=credits`) | tier/credits info | bearer | no | no | SUPPORTED |
| GET | `/v1/feedback/config` | feedback feature flags | bearer | no | no | SUPPORTED |
| GET | `/v1/mcp/tools/list` | MCP tool catalog | bearer | no | no | SUPPORTED |
| GET | `/v1/bundle/archive` | subagent/plugin bundle download | bearer | no | no | SUPPORTED |
| POST | `/v1/responses` | **inference** (OpenAI Responses API dialect) | bearer (pool-injected) | SSE (also accepts non-SSE) | response-id affinity only | SUPPORTED |
| POST | `/v1/sessions/<uuid>/signals` | session liveness/progress signals | bearer | no | **path-session uuid** | SUPPORTED |
| POST | `/v1/traces` | CLI telemetry sink | bearer | no (204) | no | SUPPORTED |
| POST | `/v1/chat/completions` | chat backend (CLI `api_backend="chat_completions"`) | bearer | SSE or JSON | tbd | OBSERVED (docs only) |
| GET | `/v1/login-config` | auth bootstrap | ? | no | ? | UNKNOWN (not seen in any run) |
| GET | `/v1/models-v2` | newer model list | ? | no | ? | UNKNOWN (not seen in any run) |
| GET | `/v1/subagents/bundle` | subagent bundle (alternative path?) | ? | no | ? | UNKNOWN (pool saw `/v1/bundle/archive` instead) |

Non-`/v1` traffic from the CLI goes to other hosts directly (auth.x.ai OIDC,
github.com marketplace) and does not traverse the pool.

## Key protocol findings (v4 discovery, 2026-09-06)

1. **The CLI is stateless per request.** Every `/v1/responses` call carries the
   full conversation; `previous_response_id` was `null` in 9/9 live requests,
   and the response echoes `"store": false`. Server-side session state is not
   required — the pool observed one session's inference succeed across three
   different accounts (08/15/13) in a row.
2. **Response ids are bare UUIDs** — top-level `"id": "<uuid>"` (no `resp_`
   prefix); reasoning items are `rs_<uuid>`; assistant messages `msg_<uuid>`.
   The API still *accepts* `previous_response_id` (echoed back), so the pool
   keeps response-id→account affinity for clients that use it.
3. **The session identifier lives in the path**, not headers:
   `POST /v1/sessions/<uuid>/signals`. Header `x-grok-session-id` /
   `x-grok-conv-id` / `x-grok-req-id` / `x-grok-agent-id` are sent **empty** by
   CLI 1.0.13 headless runs.
4. **SSE event types observed** (model `grok-4.6`):
   `response.created`, `response.in_progress`, `response.output_item.added`,
   `response.output_item.done`, `response.function_call_arguments.delta`,
   `response.function_call_arguments.done`, `response.completed`.
   (v3-era runs also had `response.output_text.delta`.)
5. **Model**: live runs use `grok-4.6` (`x-grok-model-override: grok-4.6`),
   reasoning effort `high`, `reasoning.summary: "detailed"`.
6. **Request header set** (wire capture; `x-userid` appears on pager requests —
   the pool overrides it together with `x-grok-user-id`/`x-email`):
   ```
   authorization: Bearer <account>          (swapped by pool)
   x-grok-user-id: <account user uuid>      (swapped by pool)
   x-email: <account email>                 (swapped by pool)
   x-userid: <account user uuid>            (swapped by pool when client sends it)
   x-xai-token-auth: xai-grok-cli
   x-authenticateresponse: authenticate-response
   x-grok-client-version: 1.0.13
   x-grok-client-identifier: grok-shell
   x-grok-client-mode: interactive
   x-grok-model-override: grok-4.6
   x-grok-doom-loop-check: 1024
   x-grok-exact-repetition-check: 64
   x-grok-has-grok-code-access: true
   user-agent: grok-shell/1.0.13 (windows; x86_64)
   accept: text/event-stream                (inference) | */* (pager)
   accept-encoding: gzip, br, deflate
   ```
7. **Token lifecycle**: access tokens last **6h** (21600s). Refresh works via
   OIDC discovery `https://auth.x.ai/.well-known/openid-configuration` →
   `token_endpoint = https://auth.x.ai/oauth2/token`, **form-urlencoded**
   (JSON → 415), `grant_type=refresh_token`,
   `client_id=b1a00492-073a-47ea-816f-4c329264a828` (NOT the string `grok-cli`).
8. **Error behavior seen live**: a `/v1/sessions/<uuid>/signals` call received
   403 from 5 different accounts in a row, then the CLI continued normally —
   403 is request-scoped, not account death. The pool treats 403 as a 30s
   cooldown (AUTH_FAILED only after 3 consecutive 403s); 429 honors
   `Retry-After`; 401 triggers one token refresh before failover.
9. **Cloudflare** fronts the upstream (`cf-ray`, `strict-transport-security`,
   gzip). The pool forwards response headers verbatim (hop-by-hop filtered) so
   gzip-encoded bodies pass through untouched.
10. **Subscription/paywall quirk**: upstream reports `"subscriptionTier": null`
    on `/v1/user?include=subscription` for ALL accounts (even paid ones). The
    CLI reads null → tier "Free" → hides thinking display + shows an upgrade
    banner (`paywall_check_no_subscription` in `unified.jsonl`). When the same
    endpoint 404s (as it did behind 9Router), the CLI never enters that state.
    The pool therefore patches ONLY `subscriptionTier` on `/v1/user` responses
    (default "SuperGrok", `GROK_POOL_SUBSCRIPTION_TIER=` to disable). The
    paywall check fires only in the interactive TUI (focus/heartbeat), not in
    headless runs.

## Discovery checklist (remaining)

- [ ] Interactive TUI runs (manual): startup extras, resume (`--continue` /
      `--resume`), idle-then-continue, subagent spawn traffic, worktree mode
- [ ] `/v1/login-config`, `/v1/models-v2`, `/v1/subagents/bundle` — capture or
      strike from inventory
- [ ] `/v1/chat/completions` round-trip with `api_backend="chat_completions"`
- [ ] Non-streaming `/v1/responses` (verified working via direct POST, not CLI)
- [ ] Fixture-diff regression when the CLI version bumps

Raw evidence: `tests/fixtures/` (sanitized wire captures),
`traces/requests.ndjson` (full structured log).
