import * as assert from "assert";
import * as vscode from "vscode";

const EXT_ID = "rayandrew.dftracer-viewer";

const COMMANDS = [
  "dftracer.viewer.viewTrace",
  "dftracer.viewer.viewTraces",
  "dftracer.viewer.selectServer",
  "dftracer.viewer.selectServerRelease",
  "dftracer.viewer.updateServer",
  "dftracer.viewer.showLogs",
  "dftracer.viewer.openLogFile",
  "dftracer.viewer.setServerLogLevel",
];

suite("Activation", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    await ext.activate();
  });

  test("extension is active", () => {
    assert.ok(vscode.extensions.getExtension(EXT_ID)?.isActive);
  });

  test("every contributed command is registered", async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const c of COMMANDS) assert.ok(registered.has(c), `command not registered: ${c}`);
  });

  test("no contributed command is left out of the test list", () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    const contributed: string[] = ext!.packageJSON.contributes.commands.map(
      (c: { command: string }) => c.command,
    );
    for (const c of contributed) assert.ok(COMMANDS.includes(c), `untested command: ${c}`);
  });

  test("configuration defaults", () => {
    const cfg = vscode.workspace.getConfiguration("dftracer.viewer");
    assert.strictEqual(cfg.get("serverPath"), "");
    assert.strictEqual(cfg.get("serverRelease"), "latest");
    assert.strictEqual(cfg.get("serverLogLevel"), "default");
    assert.strictEqual(cfg.get("serverStartTimeoutSec"), 120);
    assert.strictEqual(cfg.get("indexDir"), "");
    assert.deepStrictEqual(cfg.get("extraArgs"), []);
  });
});
