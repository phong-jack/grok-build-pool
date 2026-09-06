// Scriptable mock of cli-chat-proxy.grok.com for golden tests.
// Records every received request; behavior is configurable per bearer token.

import http from "node:http";
import { pathToFileURL } from "node:url";

export function createMockUpstream() {
  const received = [];
  // behavior[token] = { status, times } — return `status` for the first `times` requests
  const behavior = new Map();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const entry = {
        ts: Date.now(),
        method: req.method,
        url: req.url,
        token,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString("utf8")
      };
      received.push(entry);

      if (req.url === "/__setup" && req.method === "POST") {
        const input = JSON.parse(entry.body || "{}");
        for (const [t, b] of Object.entries(input.tokens ?? {})) behavior.set(t, { ...b, served: 0 });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      if (req.url === "/__received") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(received));
        return;
      }
      if (req.url === "/__reset") {
        received.length = 0;
        behavior.clear();
        res.writeHead(200);
        res.end();
        return;
      }

      const behave = behavior.get(token);
      if (behave && behave.served < (behave.times ?? 1)) {
        behave.served += 1;
        res.writeHead(behave.status ?? 500, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: { message: `mock failure ${behave.status}` } }));
        return;
      }

      if (req.url.startsWith("/v1/responses") && req.method === "POST") {
        const model = /"model"\s*:\s*"([^"]+)"/.exec(entry.body)?.[1] ?? "grok-4.5";
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        // deterministic SSE including multi-byte UTF-8 and the response id the tap must find
        res.write(`event: response.created\n`);
        res.write(`data: {"type":"response.created","response":{"id":"resp_mock_0001","model":"${model}"}}\n\n`);
        res.write(`event: response.output_text.delta\n`);
        res.write(`data: {"type":"response.output_text.delta","delta":"héllo wörld — ✓"}\n\n`);
        res.end(`event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_mock_0001"}}\n\n`);
        return;
      }

      if (req.url.startsWith("/v1/settings")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "settings", served_by: token, telemetry: false }));
        return;
      }

      // catch-all echo: unknown endpoints must survive the pool untouched
      res.writeHead(200, { "content-type": "application/json", "x-mock": "echo" });
      res.end(JSON.stringify({ echoed: true, method: req.method, url: req.url, served_by: token }));
    });
  });

  return {
    server,
    received,
    setBehavior(tokens) {
      for (const [t, b] of Object.entries(tokens)) behavior.set(t, { ...b, served: 0 });
    },
    clearBehavior() {
      behavior.clear();
    },
    resetReceived() {
      received.length = 0;
    },
    start() {
      return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = createMockUpstream();
  const port = await mock.start();
  console.log(`mock upstream on http://127.0.0.1:${port}`);
}
