// Sync data/accounts.extra.json with the LATEST tokens from pool.db.
//
// OAuth refresh rotates the refresh token: after the pool refreshes an account,
// the newest access/refresh tokens live in pool.db (accounts_state.token_override_*),
// and the copy in accounts.extra.json goes stale. Run this script to write the
// fresh tokens back into the file — safe before deleting pool.db, cloning the
// setup to another machine, or as periodic hygiene.
//
//   npm run export-accounts

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { PoolStore } from "../src/store/db.js";

const cfg = loadConfig();

if (!fs.existsSync(cfg.accountsExtraPath)) {
  console.log(`no extra accounts file at ${cfg.accountsExtraPath} — nothing to sync`);
  process.exit(0);
}

const fileAccounts = JSON.parse(fs.readFileSync(cfg.accountsExtraPath, "utf8"));
const store = new PoolStore(cfg.poolDbPath);
const states = store.loadAccountStates();
store.close();

const byId = new Map(states.map(s => [s.account_id, s]));
let synced = 0;

const out = fileAccounts.map((entry, i) => {
  // must mirror src/accounts/source.js id format exactly
  const id = entry.id ?? `extra-${String(i).padStart(2, "0")}-${entry.email}`;
  const state = byId.get(id);
  if (state?.token_override) {
    synced++;
    return {
      ...entry,
      accessToken: state.token_override,
      refreshToken: state.token_override_refresh ?? entry.refreshToken,
      expiresAt: state.token_override_expires_at ?? entry.expiresAt
    };
  }
  return entry;
});

fs.writeFileSync(cfg.accountsExtraPath, JSON.stringify(out, null, 2));
console.log(`synced ${synced}/${fileAccounts.length} extra account(s) from ${path.basename(cfg.poolDbPath)} -> ${path.basename(cfg.accountsExtraPath)}`);
console.log(synced ? "tokens in the file are now the freshest the pool has seen." : "no refreshed overrides found — file tokens are already current.");
