import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { extraId, loadExtraFile } from "./extra.js";

// Credentials live in 9Router's SQLite (providerConnections, provider='grok-cli').
// The pool opens it READ-ONLY: 9Router stays the single writer; the pool keeps
// its own derived state (health, refreshed tokens) in pool.db.

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function toDate(value) {
  if (!value) return null;
  if (typeof value === "number") return new Date(value > 10_000_000_000 ? value : value * 1000);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function isExpired(auth, skewMs = 30_000) {
  if (!auth?.expiresAt) return false;
  const t = Date.parse(auth.expiresAt);
  return Number.isFinite(t) && t <= Date.now() + skewMs;
}

export function accountFromRow(row) {
  const data = parseJson(row.data);
  const ps = data.providerSpecificData ?? {};
  const accessToken = data.accessToken ?? data.access_token ?? null;
  if (!accessToken) return null;
  const expiresAtDate = toDate(data.expiresAt ?? data.expires_at);
  return {
    id: row.id,
    label: String(row.priority ?? 0).padStart(2, "0"),
    email: data.email ?? row.email ?? null,
    displayName: data.displayName ?? row.name ?? null,
    priority: Number(row.priority ?? 0),
    isActive: Boolean(row.isActive),
    provider: row.provider,
    auth: {
      accessToken,
      refreshToken: data.refreshToken ?? data.refresh_token ?? null,
      idToken: ps.idToken ?? null,
      userId: ps.userId ?? data.userId ?? null,
      email: data.email ?? row.email ?? ps.email ?? null,
      expiresAt: expiresAtDate ? expiresAtDate.toISOString() : null,
      hasGrokCodeAccess: ps.hasGrokCodeAccess ?? true,
      subscriptionTier: ps.subscriptionTier ?? null
    }
  };
}

export class AccountSource {
  constructor({ dbPath, ttlMs = 30_000, extraPath = null, logger = console }) {
    this.dbPath = dbPath;
    this.ttlMs = ttlMs;
    this.extraPath = extraPath;
    this.logger = logger;
    this.db = null;
    this.cached = null;
    this.cachedAt = 0;
    this.open();
  }

  open() {
    if (!fs.existsSync(this.dbPath)) {
      this.logger.warn(`[accounts] router DB not found: ${this.dbPath} (pool starts with 0 accounts)`);
      return;
    }
    try {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    } catch {
      // older node:sqlite without readOnly — open normally, still never write
      this.db = new DatabaseSync(this.dbPath);
    }
  }

  // Accounts from an optional local JSON file (bypasses 9Router entirely).
  // Format: [{ "email", "userId", "accessToken", "refreshToken", "expiresAt", "premium" }]
  // IDs are namespaced "extra-*" so they never collide with 9Router rows.
  loadExtraAccounts() {
    const list = loadExtraFile(this.extraPath);
    const out = [];
    for (const [i, e] of list.entries()) {
      if (!e?.accessToken || !e?.email) continue;
      const exp = toDate(e.expiresAt);
      out.push({
        id: extraId(e, i),
        label: e.label ?? String(100 + i),
        email: e.email,
        displayName: e.displayName ?? e.email,
        priority: Number(e.priority ?? 100 + i),
        isActive: true,
        provider: "extra",
        premium: Boolean(e.premium),
        auth: {
          accessToken: e.accessToken,
          refreshToken: e.refreshToken ?? null,
          idToken: null,
          userId: e.userId ?? null,
          email: e.email,
          expiresAt: exp ? exp.toISOString() : null,
          hasGrokCodeAccess: true,
          subscriptionTier: e.subscriptionTier ?? null
        }
      });
    }
    return out;
  }

  refresh(force = false) {
    const now = Date.now();
    if (!force && this.cached && now - this.cachedAt < this.ttlMs) return this.cached;
    const base = this.#refreshRouter();
    const extra = this.loadExtraAccounts();
    this.cached = [...base, ...extra];
    this.cachedAt = now;
    return this.cached;
  }

  #refreshRouter() {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt
           FROM providerConnections
           WHERE provider = 'grok-cli'
           ORDER BY priority ASC, createdAt ASC`
        )
        .all();
      this._lastRouterRows = rows.map(accountFromRow).filter(Boolean);
      return this._lastRouterRows;
    } catch (error) {
      // 9Router may hold the DB briefly; serve last good router snapshot
      this.logger.warn(`[accounts] refresh failed (${error.message}); using last router snapshot`);
      return this._lastRouterRows ?? [];
    }
  }

  all() {
    return this.refresh();
  }

  byId(id) {
    return this.refresh().find(a => a.id === id) ?? null;
  }

  close() {
    try { this.db?.close(); } catch {}
    this.db = null;
  }
}
