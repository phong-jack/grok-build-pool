import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// Pool-owned state (credentials stay in 9Router's DB, opened read-only).
//   accounts_state — health/cooldown/stats + token overrides from refresh
//   sessions       — sticky bindings (previous_response_id / session id → account)
//   requests       — request history for the dashboard/inspector

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts_state (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  last_refresh_at INTEGER,
  token_override TEXT,
  token_override_expires_at TEXT,
  token_override_refresh TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  sk TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  method TEXT,
  path TEXT,
  classification TEXT,
  model TEXT,
  stream INTEGER,
  account_id TEXT,
  account_label TEXT,
  account_email TEXT,
  status INTEGER,
  latency_ms INTEGER,
  ttfb_ms INTEGER,
  bytes_in INTEGER,
  bytes_out INTEGER,
  attempts INTEGER,
  error TEXT,
  previous_response_id TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts DESC);
`;

export class PoolStore {
  constructor(dbPath, { retentionDays = 7 } = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.retentionDays = retentionDays;
    this.requests = this.db.prepare(`
      INSERT INTO requests
        (id, ts, method, path, classification, model, stream, account_id, account_label,
         account_email, status, latency_ms, ttfb_ms, bytes_in, bytes_out, attempts, error,
         previous_response_id, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    this.db.prepare("DELETE FROM requests WHERE ts < ?").run(cutoff);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  }

  // --- accounts_state ---

  loadAccountStates() {
    return this.db.prepare("SELECT * FROM accounts_state").all();
  }

  saveAccountState(state) {
    this.db.prepare(`
      INSERT INTO accounts_state
        (account_id, status, cooldown_until, consecutive_errors, request_count, error_count,
         last_used, last_error, last_error_at, last_refresh_at, token_override,
         token_override_expires_at, token_override_refresh, updated_at)
      VALUES (@account_id, @status, @cooldown_until, @consecutive_errors, @request_count,
              @error_count, @last_used, @last_error, @last_error_at, @last_refresh_at,
              @token_override, @token_override_expires_at, @token_override_refresh, @updated_at)
      ON CONFLICT(account_id) DO UPDATE SET
        status=excluded.status,
        cooldown_until=excluded.cooldown_until,
        consecutive_errors=excluded.consecutive_errors,
        request_count=excluded.request_count,
        error_count=excluded.error_count,
        last_used=excluded.last_used,
        last_error=excluded.last_error,
        last_error_at=excluded.last_error_at,
        last_refresh_at=excluded.last_refresh_at,
        token_override=excluded.token_override,
        token_override_expires_at=excluded.token_override_expires_at,
        token_override_refresh=excluded.token_override_refresh,
        updated_at=excluded.updated_at
    `).run(state);
  }

  saveTokenOverride(accountId, { accessToken, refreshToken, expiresAt }) {
    this.db.prepare(`
      UPDATE accounts_state
      SET token_override = ?, token_override_refresh = ?, token_override_expires_at = ?,
          last_refresh_at = ?, updated_at = ?
      WHERE account_id = ?
    `).run(accessToken, refreshToken ?? null, expiresAt ?? null, Date.now(), Date.now(), accountId);
  }

  // --- sessions (sticky) ---

  bindSession(sk, kind, accountId, ttlMs) {
    this.db.prepare(`
      INSERT INTO sessions (sk, kind, account_id, last_seen, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sk) DO UPDATE SET
        kind=excluded.kind, account_id=excluded.account_id,
        last_seen=excluded.last_seen, expires_at=excluded.expires_at
    `).run(sk, kind, accountId, Date.now(), Date.now() + ttlMs);
  }

  loadSessions() {
    return this.db
      .prepare("SELECT sk, kind, account_id FROM sessions WHERE expires_at >= ?")
      .all(Date.now());
  }

  // --- requests ---

  insertRequest(rec) {
    this.requests.run(
      rec.id, rec.ts, rec.method, rec.path, rec.classification, rec.model,
      rec.stream == null ? null : (rec.stream ? 1 : 0),
      rec.account_id ?? null, rec.account_label ?? null, rec.account_email ?? null,
      rec.status ?? null, rec.latency_ms ?? null, rec.ttfb_ms ?? null,
      rec.bytes_in ?? null, rec.bytes_out ?? null, rec.attempts ?? null,
      rec.error ?? null, rec.previous_response_id ?? null, rec.session_id ?? null
    );
  }

  recentRequests(limit = 100) {
    return this.db
      .prepare("SELECT * FROM requests ORDER BY ts DESC LIMIT ?")
      .all(Number(limit));
  }

  getRequest(id) {
    return this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) ?? null;
  }

  stats() {
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status IS NULL OR status >= 400 THEN 1 ELSE 0 END) AS failed,
        AVG(latency_ms) AS avg_latency_ms
      FROM requests
    `).get();
    const byStatus = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM requests GROUP BY status ORDER BY count DESC")
      .all();
    const perDay = this.db.prepare(`
      SELECT date(ts/1000, 'unixepoch') AS day, COUNT(*) AS count
      FROM requests GROUP BY day ORDER BY day DESC LIMIT 14
    `).all();
    return {
      total: totals.total ?? 0,
      success: totals.success ?? 0,
      failed: totals.failed ?? 0,
      avg_latency_ms: totals.avg_latency_ms ? Math.round(totals.avg_latency_ms) : null,
      by_status: byStatus,
      per_day: perDay
    };
  }

  close() {
    try { this.db.close(); } catch {}
  }
}
