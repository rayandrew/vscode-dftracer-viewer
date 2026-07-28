import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { ServerManager } from "../server";

// Runs against stub-server.mjs rather than a real dftracer_server, so it
// exercises the startup handshake in CI. The stub stays unresponsive for
// STUB_BUSY_MS the way a server building an index for a large trace does.
const STUB = path.join(__dirname, "..", "..", "src", "test", "stub-server.mjs");
const STUB_BUSY_MS = 8000;
// Short probes so the stub's busy window covers many timeout rounds.
const PROBE_MS = 500;

function getJson(port: number, urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => (req.destroy(), reject(new Error("stats request timed out"))));
  });
}

suite("server startup", function () {
  this.timeout(60000);
  let traceDir: string;

  suiteSetup(() => {
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dft-startup-"));
  });

  test("becomes ready once a slow-starting server answers, without flooding it", async () => {
    process.env.DFT_STUB_BUSY_MS = String(STUB_BUSY_MS);
    process.env.DFT_PROBE_TIMEOUT_MS = String(PROBE_MS);
    const mgr = new ServerManager();
    try {
      const port = await mgr.acquire(traceDir, STUB);
      assert.ok(port > 0, "expected a listen port");

      // Probes back off from 250ms to 2s, and each unanswered probe must
      // schedule exactly one retry. Before the fix a probe that timed out fired
      // both its 'timeout' and 'error' handler, doubling the number of polling
      // chains every round until the server was buried in requests.
      const stats = (await getJson(port, "/__stats")) as { requests: number };
      const ceiling = Math.ceil(STUB_BUSY_MS / 2000) + 6;
      assert.ok(
        stats.requests <= ceiling,
        `probes should stay bounded, stub saw ${stats.requests} (ceiling ${ceiling})`,
      );
    } finally {
      mgr.disposeAll();
      delete process.env.DFT_STUB_BUSY_MS;
      delete process.env.DFT_PROBE_TIMEOUT_MS;
    }
  });
});
