// Account importer (CLI only): runs `grok login` in an isolated GROK_HOME and
// upserts the resulting OAuth credentials into 9Router's providerConnections.
// The runtime proxy never writes that DB — only this tool does, on demand.

import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";

const cfg = loadConfig();

const requestedName = process.argv.slice(2).join(" ").trim();
const LOGIN_ROOT = path.resolve(cfg.loginRoot);

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `account-${Date.now()}`;
}

async function findAuthJson(rootDir) {
  const pending = [path.resolve(rootDir)];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === "auth.json") return full;
    }
  }
  return null;
}

function firstDefined(...values) {
  return values.find(v => v !== undefined && v !== null && v !== "");
}

async function parseGrokAuthFile(authFile) {
  const raw = JSON.parse(await fs.readFile(authFile, "utf8"));
  const candidates = [
    raw?.["https://accounts.x.ai/sign-in"],
    raw?.["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"],
    raw
  ].filter(Boolean);
  const entry = candidates.find(x => x.key || x.accessToken || x.access_token) ?? candidates[0];
  if (!entry) throw new Error(`Could not understand Grok auth file: ${authFile}`);
  const accessToken = firstDefined(entry.key, entry.accessToken, entry.access_token);
  if (!accessToken) throw new Error(`No access token found in ${authFile}`);
  return {
    accessToken,
    refreshToken: firstDefined(entry.refresh_token, entry.refreshToken),
    idToken: firstDefined(entry.id_token, entry.idToken),
    userId: firstDefined(entry.user_id, entry.userId),
    email: entry.email ?? null,
    displayName: entry.displayName ?? entry.name ?? entry.email ?? "Grok Account",
    expiresAt: entry.expires_at ?? entry.expiresAt ?? null,
    scope: entry.scope ?? null,
    expiresIn: entry.expiresIn ?? null
  };
}

function upsertGrokOAuth(db, auth) {
  const existing = auth.userId
    ? db.prepare(`
        SELECT id, data FROM providerConnections
        WHERE provider='grok-cli' AND json_extract(data, '$.providerSpecificData.userId') = ?
        LIMIT 1`).get(auth.userId)
    : auth.email
      ? db.prepare(`
          SELECT id, data FROM providerConnections
          WHERE provider='grok-cli' AND email = ? LIMIT 1`).get(auth.email)
      : null;

  const id = existing?.id ?? crypto.randomUUID();
  const previous = JSON.parse(existing?.data ?? "{}");
  const timestamp = new Date().toISOString();
  const data = {
    ...previous,
    displayName: auth.displayName ?? previous.displayName ?? auth.email ?? "Grok Account",
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken ?? previous.refreshToken ?? null,
    expiresAt: auth.expiresAt ?? previous.expiresAt ?? null,
    scope: auth.scope ?? previous.scope ?? null,
    expiresIn: auth.expiresIn ?? previous.expiresIn ?? null,
    testStatus: "active",
    providerSpecificData: {
      ...(previous.providerSpecificData ?? {}),
      authMethod: "device_code",
      idToken: auth.idToken ?? previous.providerSpecificData?.idToken ?? null,
      email: auth.email ?? previous.providerSpecificData?.email ?? null,
      userId: auth.userId ?? previous.providerSpecificData?.userId ?? null,
      hasGrokCodeAccess: true,
      subscriptionTier: previous.providerSpecificData?.subscriptionTier ?? null
    },
    backoffLevel: 0,
    lastError: null,
    lastErrorAt: null,
    lastRefreshAt: timestamp
  };

  if (existing) {
    db.prepare(`
      UPDATE providerConnections
      SET authType='oauth', name=?, email=?, data=?, isActive=1, updatedAt=?
      WHERE id=?`).run(
      auth.email ?? existing.email ?? auth.displayName ?? "Grok Account",
      auth.email ?? null,
      JSON.stringify(data),
      timestamp,
      id
    );
  } else {
    const maxPriority = db.prepare(`
      SELECT COALESCE(MAX(priority), 0) AS maxPriority
      FROM providerConnections WHERE provider='grok-cli'`).get().maxPriority;
    db.prepare(`
      INSERT INTO providerConnections
        (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
      VALUES (?, 'grok-cli', 'oauth', ?, ?, ?, 1, ?, ?, ?)`).run(
      id,
      auth.displayName ?? auth.email ?? "Grok Account",
      auth.email ?? null,
      Number(maxPriority) + 1,
      JSON.stringify(data),
      timestamp,
      timestamp
    );
  }
  return id;
}

const loginName = slugify(requestedName || `account-${Date.now()}`);
const grokHome = path.join(LOGIN_ROOT, loginName);
await fs.mkdir(grokHome, { recursive: true });

console.log("grok-pool — login importer");
console.log(`GROK_HOME:  ${grokHome}`);
console.log(`9Router DB: ${cfg.routerDbPath}`);
console.log("Complete the normal Grok CLI login in the browser/device flow.\n");

const child = spawn("grok", ["login"], {
  stdio: "inherit",
  env: { ...process.env, GROK_HOME: grokHome },
  shell: process.platform === "win32"
});

const exitCode = await new Promise(resolve => child.on("exit", code => resolve(code ?? 1)));
if (exitCode !== 0) process.exit(exitCode);

const authFile = await findAuthJson(grokHome);
if (!authFile) throw new Error(`Login completed but auth.json was not found below ${grokHome}`);

const auth = await parseGrokAuthFile(authFile);
const db = new DatabaseSync(cfg.routerDbPath);
const id = upsertGrokOAuth(db, auth);
db.close();

console.log(`\n✓ Imported Grok account into 9Router providerConnections`);
console.log(`  id:     ${id}`);
console.log(`  email:  ${auth.email ?? "unknown"}`);
console.log(`  source: ${authFile}`);
