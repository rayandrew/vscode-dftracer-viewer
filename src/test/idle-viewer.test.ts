import * as assert from "assert";
import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import * as vscode from "vscode";
import { activeViewerForTests, setWindowFocusForTests } from "../extension";

// Drives the real viewer command: opens a trace, hides the tab and expects the
// extension to stop the server once it sits idle. Runs against the real
// dftracer_server when DFTRACER_SERVER_PATH is set, else stub-server.mjs.
const STUB = path.join(__dirname, "..", "..", "src", "test", "stub-server.mjs");
const SERVER = process.env.DFTRACER_SERVER_PATH || STUB;
const IDLE_MIN = 0.03;
const IDLE_MS = IDLE_MIN * 60_000;

const config = () => vscode.workspace.getConfiguration("dftracer.viewer");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serverRunning(traceDir: string): boolean {
  const out = child_process.execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });
  return out.split("\n").some((l) => l.includes(` -d ${traceDir} `));
}

// Runs the page's own script against its buttons and returns what a click on
// the button labelled `label` posts to the extension.
function clickButton(html: string, label: string): { type: string }[] {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "page has no script");
  const buttons = [
    ...html.matchAll(/<button[^>]*data-act="([^"]+)"[^>]*>\s*([^<]*?)\s*<\/button>/g),
  ].map((m) => ({ act: m[1], text: m[2], handlers: [] as (() => void)[] }));
  const posted: { type: string }[] = [];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (m: { type: string }) => posted.push(m) }),
    document: {
      getElementById: () => null,
      querySelectorAll: () =>
        buttons.map((b) => ({
          getAttribute: () => b.act,
          addEventListener: (_event: string, fn: () => void) => b.handlers.push(fn),
        })),
    },
  });
  const target = buttons.find((b) => b.text === label);
  assert.ok(target, `page has no "${label}" button`);
  target.handlers.forEach((h) => h());
  return posted;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

(process.platform === "win32" ? suite.skip : suite)("Idle server shutdown", function () {
  this.timeout(60000);

  const keys = ["serverPath", "serverIdleTimeoutMin", "serverAutoShutdown"];
  const saved = new Map<string, unknown>();
  let traceDir: string;

  suiteSetup(async () => {
    for (const k of keys) saved.set(k, config().inspect(k)?.globalValue);
    await config().update("serverPath", SERVER, vscode.ConfigurationTarget.Global);
    await config().update("serverIdleTimeoutMin", IDLE_MIN, vscode.ConfigurationTarget.Global);
    await config().update("serverAutoShutdown", "0", vscode.ConfigurationTarget.Global);
    process.env.DFT_STUB_BUSY_MS = "0";
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const k of keys) {
      await config().update(k, saved.get(k), vscode.ConfigurationTarget.Global);
    }
    delete process.env.DFT_STUB_BUSY_MS;
  });

  setup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dft-idle-viewer-"));
  });

  teardown(() => {
    setWindowFocusForTests();
    fs.rmSync(traceDir, { recursive: true, force: true });
  });

  async function openViewer(): Promise<void> {
    await vscode.commands.executeCommand("dftracer.viewer.viewTrace", vscode.Uri.file(traceDir));
    assert.ok(await waitFor(() => serverRunning(traceDir), 20000), "server did not start");
  }

  test("a visible viewer in a focused window keeps its server", async () => {
    setWindowFocusForTests(() => true);
    await openViewer();
    await sleep(IDLE_MS * 2);
    assert.ok(serverRunning(traceDir), "server stopped while the viewer was active");
  });

  test("a hidden viewer loses its server after the idle timeout", async () => {
    setWindowFocusForTests(() => true);
    await openViewer();

    // A text editor in the same group hides the viewer tab.
    const doc = await vscode.workspace.openTextDocument({ content: "" });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);

    assert.ok(
      await waitFor(() => !serverRunning(traceDir), IDLE_MS + 10000),
      "server was still running after the idle timeout",
    );
  });

  test("a visible viewer in an unfocused window loses its server", async () => {
    setWindowFocusForTests(() => false);
    await openViewer();
    assert.ok(
      await waitFor(() => !serverRunning(traceDir), IDLE_MS + 10000),
      "server was still running after the idle timeout",
    );
  });

  test("the Restart server button brings the server back", async () => {
    setWindowFocusForTests(() => false);
    await openViewer();
    assert.ok(
      await waitFor(() => !serverRunning(traceDir), IDLE_MS + 10000),
      "server was still running after the idle timeout",
    );

    const viewer = activeViewerForTests();
    assert.ok(viewer, "no active viewer");
    const posted = clickButton(viewer.html(), "Restart server");
    assert.strictEqual(posted.length, 1, "click should post one message");

    setWindowFocusForTests(() => true);
    await viewer.send(posted[0]);
    assert.ok(await waitFor(() => serverRunning(traceDir), 20000), "server did not restart");
    await sleep(IDLE_MS * 2);
    assert.ok(serverRunning(traceDir), "restarted server stopped while the viewer was active");
    assert.ok(!viewer.html().includes("Restart server"), "idle screen is still shown");
  });

  test("regaining focus before the timeout keeps the server", async () => {
    setWindowFocusForTests(() => false);
    await openViewer();
    setWindowFocusForTests(() => true);
    await sleep(IDLE_MS * 2);
    assert.ok(serverRunning(traceDir), "server stopped after focus returned");
  });
});
