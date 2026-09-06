// Shared helpers for the optional extra-accounts file (data/accounts.extra.json).
// Used by AccountSource (read), the admin API (add/remove/sync) and the CLI exporter.

import fs from "node:fs";
import path from "node:path";

// must stay in sync with src/accounts/source.js loadExtraAccounts()
export function extraId(entry, index) {
  return entry.id ?? `extra-${String(index).padStart(2, "0")}-${entry.email}`;
}

export function extraFilePath(poolDbPath) {
  return path.join(path.dirname(path.resolve(poolDbPath)), "accounts.extra.json");
}

export function loadExtraFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveExtraFile(file, accounts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(accounts, null, 2));
}

// Add or replace (by email) an entry. Returns the updated list.
export function addExtraAccount(file, entry) {
  const list = loadExtraFile(file);
  const idx = list.findIndex(e => e.email === entry.email);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...entry, premium: entry.premium ?? list[idx].premium ?? true };
  } else {
    list.push({ premium: true, ...entry });
  }
  saveExtraFile(file, list);
  return list;
}

export function removeExtraAccount(file, idOrEmail) {
  const list = loadExtraFile(file);
  const kept = list.filter((e, i) => extraId(e, i) !== idOrEmail && e.email !== idOrEmail);
  if (kept.length !== list.length) saveExtraFile(file, kept);
  return { list: kept, removed: kept.length !== list.length };
}

// Write the newest tokens (from pool.db overrides) back into the file.
export function syncExtraFromOverrides(file, accountStates) {
  const list = loadExtraFile(file);
  const byId = new Map(accountStates.map(s => [s.account_id, s]));
  let synced = 0;
  const out = list.map((entry, i) => {
    const state = byId.get(extraId(entry, i));
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
  saveExtraFile(file, out);
  return { synced, total: list.length };
}
