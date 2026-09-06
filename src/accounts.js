// CLI: list accounts as the pool sees them (health + token expiry).

import "dotenv/config";
import { loadConfig } from "./config.js";
import { AccountSource, isExpired } from "./accounts/source.js";
import { HealthTracker } from "./pool/health.js";
import { PoolStore } from "./store/db.js";
import { StickyIndex } from "./pool/sticky.js";
import { AccountPool } from "./pool/pool.js";

const cfg = loadConfig();
const source = new AccountSource({ dbPath: cfg.routerDbPath, ttlMs: 0 });
const store = new PoolStore(cfg.poolDbPath);
const health = new HealthTracker({ store });
const pool = new AccountPool({ source, sticky: new StickyIndex(), health, strategy: cfg.strategy });

console.table(pool.summary().map(a => ({
  label: a.label,
  email: a.email,
  status: a.status,
  usable: a.isActive && !isExpired(source.byId(a.id).auth) && a.status === "ACTIVE",
  reqs: a.request_count,
  errors: a.error_count,
  cooldown_ms: a.cooldown_remaining_ms,
  expires_at: a.token_expires_at ?? ""
})));

source.close();
store.close();
