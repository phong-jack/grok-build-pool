// Sticky routing: response_id / session_id → account. In-memory map is
// authoritative at runtime; write-through to pool.db so restarts keep affinity.

const MAX_ENTRIES = 50_000;

export class StickyIndex {
  constructor({ store, ttlMs = 3_600_000 } = {}) {
    this.store = store ?? null;
    this.ttlMs = ttlMs;
    this.byResponseId = new Map(); // response_id -> { accountId, expiresAt }
    this.bySessionKey = new Map(); // session/conv id -> { accountId, expiresAt }
    if (this.store) this.#load();
  }

  #load() {
    try {
      for (const row of this.store.loadSessions()) {
        const entry = { accountId: row.account_id, expiresAt: Date.now() + this.ttlMs };
        if (row.kind === "response") this.byResponseId.set(row.sk, entry);
        else this.bySessionKey.set(row.sk, entry);
      }
    } catch {}
  }

  #set(map, key, accountId) {
    if (!key || !accountId) return;
    if (map.size >= MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
    map.set(key, { accountId, expiresAt: Date.now() + this.ttlMs });
    try {
      this.store?.bindSession(key, map === this.byResponseId ? "response" : "session", accountId, this.ttlMs);
    } catch {}
  }

  #get(map, key) {
    if (!key) return null;
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      map.delete(key);
      return null;
    }
    return entry.accountId;
  }

  bindResponse(responseId, accountId) {
    this.#set(this.byResponseId, responseId, accountId);
  }

  bindSession(sessionKey, accountId) {
    this.#set(this.bySessionKey, sessionKey, accountId);
  }

  resolveByResponseId(responseId) {
    return this.#get(this.byResponseId, responseId);
  }

  resolveBySessionKey(sessionKey) {
    return this.#get(this.bySessionKey, sessionKey);
  }

  size() {
    return { responses: this.byResponseId.size, sessions: this.bySessionKey.size };
  }

  prune() {
    const now = Date.now();
    for (const [k, v] of this.byResponseId) if (v.expiresAt < now) this.byResponseId.delete(k);
    for (const [k, v] of this.bySessionKey) if (v.expiresAt < now) this.bySessionKey.delete(k);
  }
}
