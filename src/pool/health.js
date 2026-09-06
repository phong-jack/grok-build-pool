// Per-account health state machine:
//   ACTIVE ⇄ COOLDOWN (short backoff)
//   ACTIVE → RATE_LIMITED (429, Retry-After aware)
//   ACTIVE → AUTH_FAILED (401/403 after a refresh attempt failed)
//   ACTIVE → DEGRADED (2+ consecutive 5xx/network) → DEAD (5+)
// Success on any request/probe restores ACTIVE.

const DEGRADED_THRESHOLD = 2;
const DEAD_THRESHOLD = 5;
const DEGRADED_COOLDOWN_MS = 15_000;
const RATE_LIMIT_FALLBACK_MS = 90_000;

export class HealthTracker {
  constructor({ store } = {}) {
    this.store = store ?? null;
    this.state = new Map(); // accountId -> mutable state
    if (this.store) this.#load();
  }

  #load() {
    try {
      for (const row of this.store.loadAccountStates()) {
        this.state.set(row.account_id, {
          status: row.status ?? "ACTIVE",
          cooldownUntil: row.cooldown_until ?? 0,
          consecutiveErrors: row.consecutive_errors ?? 0,
          requestCount: row.request_count ?? 0,
          errorCount: row.error_count ?? 0,
          lastUsed: row.last_used ?? null,
          lastError: row.last_error ?? null,
          lastErrorAt: row.last_error_at ?? null,
          lastRefreshAt: row.last_refresh_at ?? null
        });
      }
    } catch {}
  }

  #of(accountId) {
    let s = this.state.get(accountId);
    if (!s) {
      s = {
        status: "ACTIVE",
        cooldownUntil: 0,
        consecutiveErrors: 0,
        requestCount: 0,
        errorCount: 0,
        lastUsed: null,
        lastError: null,
        lastErrorAt: null,
        lastRefreshAt: null
      };
      this.state.set(accountId, s);
    }
    return s;
  }

  #persist(accountId, s) {
    if (!this.store) return;
    try {
      this.store.saveAccountState({
        account_id: accountId,
        status: s.status,
        cooldown_until: s.cooldownUntil,
        consecutive_errors: s.consecutiveErrors,
        request_count: s.requestCount,
        error_count: s.errorCount,
        last_used: s.lastUsed,
        last_error: s.lastError,
        last_error_at: s.lastErrorAt,
        last_refresh_at: s.lastRefreshAt,
        token_override: null,
        token_override_expires_at: null,
        token_override_refresh: null,
        updated_at: Date.now()
      });
    } catch {}
  }

  recordRefresh(accountId) {
    const s = this.#of(accountId);
    s.lastRefreshAt = Date.now();
    this.#persist(accountId, s);
  }

  recordSuccess(accountId) {
    const s = this.#of(accountId);
    s.status = "ACTIVE";
    s.cooldownUntil = 0;
    s.consecutiveErrors = 0;
    s.requestCount += 1;
    s.lastUsed = Date.now();
    this.#persist(accountId, s);
  }

  recordFailure(accountId, kind, { retryAfterMs, message } = {}) {
    const s = this.#of(accountId);
    s.requestCount += 1;
    s.errorCount += 1;
    s.lastUsed = Date.now();
    s.lastError = message ?? kind;
    s.lastErrorAt = Date.now();
    s.consecutiveErrors += 1;

    switch (kind) {
      case "rate_limit": {
        s.status = "RATE_LIMITED";
        s.cooldownUntil = Date.now() + (retryAfterMs ?? RATE_LIMIT_FALLBACK_MS);
        break;
      }
      case "auth":
        s.status = "AUTH_FAILED";
        s.cooldownUntil = 0;
        break;
      case "forbidden":
        // 403 is often request-scoped (upstream refusing THIS request), not a
        // dead token — cool down briefly; only repeated 403s mark auth failure.
        if (s.consecutiveErrors >= 3) {
          s.status = "AUTH_FAILED";
          s.cooldownUntil = 0;
        } else {
          s.status = "COOLDOWN";
          s.cooldownUntil = Date.now() + 30_000;
        }
        break;
      case "server":
      case "network":
      case "timeout": {
        if (s.consecutiveErrors >= DEAD_THRESHOLD) {
          s.status = "DEAD";
          s.cooldownUntil = 0;
        } else if (s.consecutiveErrors >= DEGRADED_THRESHOLD) {
          s.status = "DEGRADED";
          s.cooldownUntil = Date.now() + DEGRADED_COOLDOWN_MS;
        } else {
          s.status = "ACTIVE";
          s.cooldownUntil = Date.now() + 1_000;
        }
        break;
      }
      case "cooldown_only": {
        s.status = s.status === "ACTIVE" ? "COOLDOWN" : s.status;
        s.cooldownUntil = Date.now() + (retryAfterMs ?? 1_000);
        break;
      }
      default:
        // client errors (400/404/422...) are not the account's fault
        s.status = s.status === "RATE_LIMITED" || s.status === "DEGRADED" ? s.status : "ACTIVE";
        s.consecutiveErrors = 0;
        break;
    }
    this.#persist(accountId, s);
  }

  get(accountId) {
    const s = this.#of(accountId);
    const effective = this.effectiveStatus(accountId);
    return { ...s, effective };
  }

  effectiveStatus(accountId) {
    const s = this.#of(accountId);
    if (s.cooldownUntil > Date.now()) {
      return s.status === "RATE_LIMITED" ? "RATE_LIMITED"
        : s.status === "DEGRADED" ? "DEGRADED"
        : s.status === "DEAD" ? "DEAD"
        : s.status === "AUTH_FAILED" ? "AUTH_FAILED"
        : "COOLDOWN";
    }
    if (s.status === "RATE_LIMITED" || s.status === "DEGRADED" || s.status === "COOLDOWN") return "ACTIVE";
    return s.status; // ACTIVE | AUTH_FAILED | DEAD persist until proven otherwise
  }

  isUsable(accountId) {
    return this.effectiveStatus(accountId) === "ACTIVE";
  }

  cooldownSoonest(accountIds) {
    let best = null;
    for (const id of accountIds) {
      const s = this.#of(id);
      const eff = this.effectiveStatus(id);
      if (eff === "AUTH_FAILED" || eff === "DEAD") continue;
      if (!best || s.cooldownUntil < this.#of(best).cooldownUntil) best = id;
    }
    return best;
  }

  snapshot() {
    const out = {};
    for (const [id, s] of this.state) out[id] = { ...s, effective: this.effectiveStatus(id) };
    return out;
  }
}
