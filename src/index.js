import "dotenv/config";
import { loadConfig } from "./config.js";
import { Trace } from "./trace/index.js";
import { AccountSource, isExpired } from "./accounts/source.js";
import { PoolStore } from "./store/db.js";
import { StickyIndex } from "./pool/sticky.js";
import { HealthTracker } from "./pool/health.js";
import { AccountPool } from "./pool/pool.js";
import { startProber } from "./pool/prober.js";
import { createAdminHandler } from "./admin/api.js";
import { createServer } from "./server.js";

const cfg = loadConfig();

const trace = new Trace(cfg.trace);
const source = new AccountSource({ dbPath: cfg.routerDbPath, ttlMs: cfg.accountsTtlMs, extraPath: cfg.accountsExtraPath });
const store = new PoolStore(cfg.poolDbPath, { retentionDays: cfg.requestRetentionDays });
const sticky = new StickyIndex({ store, ttlMs: cfg.stickyTtlMs });
const health = new HealthTracker({ store });
const pool = new AccountPool({ source, sticky, health, strategy: cfg.strategy, premiumModels: cfg.premiumModels });

// Apply refreshed-token overrides from pool.db on top of the read-only 9Router rows.
for (const rowState of store.loadAccountStates()) {
  if (!rowState.token_override) continue;
  const account = source.byId(rowState.account_id);
  if (!account) continue;
  const overrideExp = Date.parse(rowState.token_override_expires_at ?? "");
  if (Number.isFinite(overrideExp) && overrideExp > Date.now() + 30_000 && !isExpired({ expiresAt: rowState.token_override_expires_at })) {
    account.auth.accessToken = rowState.token_override;
    if (rowState.token_override_refresh) account.auth.refreshToken = rowState.token_override_refresh;
    account.auth.expiresAt = rowState.token_override_expires_at;
  }
}

const ctx = { cfg, trace, source, store, sticky, health, pool };
ctx.admin = createAdminHandler({ ctx });

const server = createServer({ ctx });

setInterval(() => sticky.prune(), 300_000).unref();
setInterval(() => store.prune(), 3_600_000).unref();
const prober = startProber({ pool, health, cfg, store });
// first probe pass shortly after boot so stale states don't linger
setTimeout(() => prober.tick(), 10_000).unref();

server.listen(cfg.port, cfg.host, () => {
  const accounts = pool.accounts();
  const usable = accounts.filter(a => a.isActive && !isExpired(a.auth) && health.isUsable(a.id)).length;
  const expired = accounts.filter(a => isExpired(a.auth)).length;
  console.log(`
grok-pool v${cfg.version} — transparent gateway
  local:     http://${cfg.host}:${cfg.port}
  upstream:  ${cfg.upstreamOrigin} (path+query forwarded verbatim)
  accounts:  ${accounts.length} total / ${usable} usable / ${expired} expired-token
  strategy:  ${cfg.strategy}, failover attempts: ${cfg.maxFailovers + 1}
  sticky:    ${sticky.size().responses} response bindings, ${sticky.size().sessions} session bindings
  trace:     ${trace.level} -> ${cfg.trace.dir}
  dashboard: http://${cfg.host}:${cfg.port}/dashboard
`);
  if (!accounts.length) {
    console.warn(`  !! no grok-cli accounts found in ${cfg.routerDbPath}`);
  } else if (!usable) {
    console.warn("  !! no usable accounts (tokens expired / all cooling down) — refresh will be attempted on first request");
  }
});

function shutdown() {
  console.log("\n[pool] shutting down...");
  server.close(() => {
    source.close();
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
