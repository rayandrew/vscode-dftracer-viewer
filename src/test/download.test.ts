import * as assert from "assert";
import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  clearServerCache,
  hasCachedServer,
  listReleases,
  resolveServerBinary,
  sweepRetiredServers,
} from "../download";

// These hit the GitHub releases of llnl-asr/dftracer-utils, so they need network.
const SUPPORTED = ["linux-x64", "linux-arm64", "darwin-arm64"].includes(
  `${process.platform}-${process.arch}`,
);
const PINNED_TAG = "v0.0.14";

const config = () => vscode.workspace.getConfiguration("dftracer.viewer");

(SUPPORTED ? suite : suite.skip)("Server download", function () {
  this.timeout(180000);

  let storage: string;
  let context: vscode.ExtensionContext;
  let savedRelease: string | undefined;

  suiteSetup(async () => {
    savedRelease = config().inspect<string>("serverRelease")?.globalValue;
    await config().update("serverPath", "", vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    await config().update("serverRelease", savedRelease, vscode.ConfigurationTarget.Global);
  });

  setup(() => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "dft-download-test-"));
    context = { globalStorageUri: vscode.Uri.file(storage) } as vscode.ExtensionContext;
  });

  teardown(() => {
    fs.rmSync(storage, { recursive: true, force: true });
  });

  const selectRelease = (tag: string) =>
    config().update("serverRelease", tag, vscode.ConfigurationTarget.Global);

  test("lists releases with an asset for this platform", async () => {
    const releases = await listReleases();
    const pinned = releases.find((r) => r.tag === PINNED_TAG);
    assert.ok(pinned, `${PINNED_TAG} not listed`);
    assert.ok(pinned.hasAssetForPlatform);
    assert.ok(releases.some((r) => r.tag === "develop-latest" && r.prerelease));
  });

  test("downloads, verifies and caches a pinned release", async () => {
    await selectRelease(PINNED_TAG);
    assert.strictEqual(hasCachedServer(context), false);

    const steps: string[] = [];
    const binary = await resolveServerBinary(context, (m) => steps.push(m));
    assert.ok(binary.startsWith(storage));
    assert.ok(binary.includes(`${path.sep}${PINNED_TAG}${path.sep}dftracer-utils-0.0.14-`));
    assert.ok(steps.some((s) => s.startsWith("Verifying checksum")));
    assert.ok(hasCachedServer(context));

    const version = child_process.execFileSync(binary, ["--version"], { encoding: "utf8" });
    assert.ok(version.includes("0.0.14"), `unexpected version output: ${version}`);

    const again: string[] = [];
    assert.strictEqual(await resolveServerBinary(context, (m) => again.push(m)), binary);
    assert.ok(!again.some((s) => s.startsWith("Downloading")), "cached call re-downloaded");
  });

  test("a rolling pre-release replaces the previous cache", async () => {
    await selectRelease(PINNED_TAG);
    const pinned = await resolveServerBinary(context, () => {});

    await selectRelease("develop-latest");
    const rolling = await resolveServerBinary(context, () => {});
    assert.notStrictEqual(rolling, pinned);
    assert.ok(fs.existsSync(rolling));
    assert.ok(!fs.existsSync(pinned), "previous release was not pruned");
  });

  // Chmod stands in for a server holding a file open: both make the delete fail.
  (process.getuid?.() === 0 ? test.skip : test)(
    "a delete that fails does not block the next download",
    async () => {
      await selectRelease(PINNED_TAG);
      const first = await resolveServerBinary(context, () => {});
      const installDir = path.dirname(path.dirname(first));
      fs.chmodSync(installDir, 0o555);
      const retired = () => fs.readdirSync(storage).filter((n) => n.startsWith("servers-retired-"));
      try {
        clearServerCache(context);
        assert.strictEqual(hasCachedServer(context), false);
        assert.strictEqual(retired().length, 1, "locked cache should be kept aside");

        const second = await resolveServerBinary(context, () => {});
        assert.ok(fs.existsSync(second));
        assert.ok(hasCachedServer(context));
      } finally {
        for (const name of retired()) {
          fs.chmodSync(
            path.join(
              storage,
              name,
              path.basename(path.dirname(installDir)),
              path.basename(installDir),
            ),
            0o755,
          );
        }
      }
      sweepRetiredServers(context);
      assert.deepStrictEqual(retired(), []);
    },
  );

  test("an unknown release is an error", async () => {
    await selectRelease("v0.0.0-does-not-exist");
    await assert.rejects(
      resolveServerBinary(context, () => {}),
      /404/,
    );
  });
});
