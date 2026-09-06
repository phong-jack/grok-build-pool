import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleProxy } from "./proxy.js";

const DASHBOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard");

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function serveStatic(res, file) {
  const ext = path.extname(file);
  const type = STATIC_TYPES[ext];
  if (!type) return false;
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export function createServer({ ctx }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = decodeURIComponent(url.pathname);

      // --- local surface (never forwarded) ---
      if (pathname === "/" || pathname === "/dashboard" || pathname === "/dashboard/") {
        return void serveStatic(res, path.join(DASHBOARD_DIR, "index.html"));
      }
      if (pathname.startsWith("/dashboard/")) {
        const file = path.join(DASHBOARD_DIR, pathname.slice("/dashboard/".length));
        if (!file.toLowerCase().startsWith(DASHBOARD_DIR.toLowerCase())) { res.writeHead(403).end(); return; }
        if (serveStatic(res, file)) return;
      }
      if (pathname === "/health") {
        // convenience alias -> admin health
        req.url = "/pool/health";
        return void ctx.admin(req, res, "/pool/health", new URLSearchParams());
      }
      if (pathname.startsWith("/pool/") || pathname === "/pool") {
        return void ctx.admin(req, res, pathname, url.searchParams);
      }

      // --- catch-all: everything else goes upstream, traced ---
      await handleProxy({ ctx, req, res, pathname });
    } catch (error) {
      console.error("[server]", error);
      if (!res.headersSent) {
        const body = JSON.stringify({ error: { type: "pool_internal", message: error.message } });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(body);
      } else {
        res.destroy();
      }
    }
  });
}
