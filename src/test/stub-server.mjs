#!/usr/bin/env node
// Stands in for dftracer_server so the startup handshake can be tested without
// a real binary. Listens immediately, then leaves every request hanging for
// DFT_STUB_BUSY_MS to mimic a server pinned building an index for a large
// trace. Reports how many requests it saw on /__stats.
import * as http from "http";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("-p") + 1]);
const busyMs = Number(process.env.DFT_STUB_BUSY_MS ?? 11000);

const start = Date.now();
let requests = 0;

const server = http.createServer((req, res) => {
  const seen = requests;
  requests += 1;
  if (req.url === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ requests: seen }));
    return;
  }
  // Still indexing: accept the connection but never answer.
  if (Date.now() - start < busyMs) return;
  if (req.url === "/api/v1/info") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><body>stub</body></html>");
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`DFTracer server listening on 127.0.0.1:${port}\n`);
});

// Keep logging so the idle watchdog never trips while we are "indexing".
const ticker = setInterval(() => {
  process.stderr.write(`INFO indexing… (${Math.round((Date.now() - start) / 1000)}s)\n`);
  if (Date.now() - start >= busyMs) clearInterval(ticker);
}, 1000);
