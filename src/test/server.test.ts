import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { gzipSync } from "zlib";
import { ServerManager, fetchServerHtml } from "../server";

// Point at a dftracer_server to run these; skipped otherwise (e.g. CI without a
// binary). Locally: DFTRACER_SERVER_PATH=/path/to/dftracer_server npm test.
const SERVER = process.env.DFTRACER_SERVER_PATH;

function ping(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/v1/info", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => (req.destroy(), resolve(false)));
  });
}

async function waitDown(port: number, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (!(await ping(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

suite("ServerManager", function () {
  this.timeout(40000);
  let traceDir: string;

  suiteSetup(function () {
    if (!SERVER || !fs.existsSync(SERVER)) this.skip();
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dft-trace-"));
    const lines =
      [
        "[",
        JSON.stringify({
          id: 1,
          name: "HH",
          cat: "HH",
          pid: 0,
          tid: 0,
          ph: "M",
          args: { name: "n1", value: "h" },
        }),
        JSON.stringify({
          id: 2,
          name: "read",
          cat: "POSIX",
          pid: 100,
          tid: 100,
          ts: 1000000,
          dur: 500,
          ph: "X",
          args: { hhash: "h", ret: 4096 },
        }),
      ].join("\n") + "\n";
    fs.writeFileSync(path.join(traceDir, "t.pfw.gz"), gzipSync(Buffer.from(lines)));
  });

  test("starts, serves the UI, ref-counts, and stops", async () => {
    const mgr = new ServerManager();
    try {
      const port = await mgr.acquire(traceDir, SERVER!);
      assert.ok(port > 0, "expected a listen port");
      assert.ok(await ping(port), "server should answer /api/v1/info");

      const html = await fetchServerHtml(port);
      assert.match(html, /<html|<!doctype/i, "GET / should return an HTML page");

      const port2 = await mgr.acquire(traceDir, SERVER!);
      assert.strictEqual(port2, port, "same trace dir should reuse the server");

      mgr.release(traceDir);
      assert.ok(await ping(port), "server should stay up while a reference remains");

      mgr.release(traceDir);
      assert.ok(await waitDown(port), "server should stop after the last release");
    } finally {
      mgr.disposeAll();
    }
  });

  test("uses an ephemeral index, not the trace directory", async () => {
    const mgr = new ServerManager();
    try {
      await mgr.acquire(traceDir, SERVER!);
      const stray = fs.readdirSync(traceDir).filter((f) => /index|\.dft/i.test(f));
      assert.deepStrictEqual(stray, [], "index should not be written into the trace dir");
    } finally {
      mgr.disposeAll();
    }
  });
});
