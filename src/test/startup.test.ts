import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { ServerManager } from "../server";

// Runs against stub-server.mjs rather than a real dftracer_server, so it
// exercises the startup handshake in CI. The stub stays unresponsive for
// STUB_BUSY_MS the way a server building its activity summary does, and 404s
// everything but / the way newer server builds do.
const STUB = path.join(__dirname, "..", "..", "src", "test", "stub-server.mjs");
const STUB_BUSY_MS = 8000;

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

  test("becomes ready on a server with no /api/v1/info, once it answers", async () => {
    process.env.DFT_STUB_BUSY_MS = String(STUB_BUSY_MS);
    const mgr = new ServerManager();
    try {
      const started = Date.now();
      const port = await mgr.acquire(traceDir, STUB);
      assert.ok(port > 0, "expected a listen port");
      assert.ok(
        Date.now() - started >= STUB_BUSY_MS,
        "should not report ready before the server actually answers",
      );

      // Probes must not be abandoned and retried while the server is working:
      // that is a request storm aimed at a process that is already busy.
      const stats = (await getJson(port, "/__stats")) as { requests: number };
      assert.ok(
        stats.requests <= 3,
        `should wait on the pending probe, stub saw ${stats.requests} requests`,
      );
    } finally {
      mgr.disposeAll();
      delete process.env.DFT_STUB_BUSY_MS;
    }
  });
});
