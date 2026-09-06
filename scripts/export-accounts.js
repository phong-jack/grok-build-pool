// Sync data/accounts.extra.json with the LATEST tokens from pool.db.
// (Same logic as POST /pool/export-accounts — kept as a CLI for cron/hygiene.)
//
//   npm run export-accounts

import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { PoolStore } from "../src/store/db.js";
import { syncExtraFromOverrides } from "../src/accounts/extra.js";

const cfg = loadConfig();
const store = new PoolStore(cfg.poolDbPath);
const result = syncExtraFromOverrides(cfg.accountsExtraPath, store.loadAccountStates());
store.close();

console.log(`synced ${result.synced}/${result.total} extra account(s) from ${cfg.poolDbPath} -> ${cfg.accountsExtraPath}`);
console.log(result.synced ? "tokens in the file are now the freshest the pool has seen." : "no refreshed overrides found — file tokens are already current.");
