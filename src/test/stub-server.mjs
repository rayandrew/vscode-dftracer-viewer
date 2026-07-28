#!/usr/bin/env node
// Stands in for dftracer_server so the startup handshake can be tested without
// a real binary. Mimics the newer server builds: /api/v1/info is gone and 404s,
// only / serves. Answers nothing for the first DFT_STUB_BUSY_MS, the way a
// server does while it builds its activity summary. Counts requests on
// /__stats.
import * as http from "http";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("-p") + 1]);
const busyMs = Number(process.env.DFT_STUB_BUSY_MS ?? 11000);

let requests = 0;
let buildStarted = 0;

const server = http.createServer((req, res) => {
  const seen = requests;
  requests += 1;
  if (req.url === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ requests: seen }));
    return;
  }
  // The first request kicks off the summary build; nothing is answered until
  // it finishes. Abandoning a request does not abandon the build.
  if (!buildStarted) buildStarted = Date.now();
  const remaining = busyMs - (Date.now() - buildStarted);
  if (remaining > 0) {
    setTimeout(() => respond(req, res), remaining);
    return;
  }
  respond(req, res);
});

function respond(req, res) {
  if (req.destroyed || res.destroyed) return;
  if (req.url !== "/") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><body>stub</body></html>");
}

const start = Date.now();
server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`DFTracer server listening on 127.0.0.1:${port}\n`);
});

// Keep logging so the idle watchdog never trips while we are "indexing".
const ticker = setInterval(() => {
  process.stderr.write(`INFO indexing… (${Math.round((Date.now() - start) / 1000)}s)\n`);
  if (buildStarted && Date.now() - buildStarted >= busyMs) clearInterval(ticker);
}, 1000);
