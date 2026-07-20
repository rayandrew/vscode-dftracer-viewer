import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ServerManager, fetchServerHtml } from "./server";
import { clearServerCache, hasCachedServer, listReleases, resolveServerBinary } from "./download";
import { log, initLogFile, logFileUri } from "./log";

const SERVER_LOG_LEVELS = ["default", "trace", "debug", "info", "warn", "error", "off"];

const manager = new ServerManager();
let activeViewer: Viewer | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLogFile(context);
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("dftracer.viewer.viewTrace", (uri?: vscode.Uri) =>
      openFromCommand(context, uri),
    ),
    vscode.commands.registerCommand("dftracer.viewer.viewTraces", (uri?: vscode.Uri) =>
      openFromCommand(context, uri),
    ),
    vscode.commands.registerCommand("dftracer.viewer.selectServer", () => selectServer(context)),
    vscode.commands.registerCommand("dftracer.viewer.selectServerRelease", () =>
      selectServerRelease(context),
    ),
    vscode.commands.registerCommand("dftracer.viewer.updateServer", () => updateServer(context)),
    vscode.commands.registerCommand("dftracer.viewer.showLogs", () => log.show()),
    vscode.commands.registerCommand("dftracer.viewer.openLogFile", () => openLogFile()),
    vscode.commands.registerCommand("dftracer.viewer.setServerLogLevel", () => setServerLogLevel()),
    vscode.window.registerCustomEditorProvider(
      "dftracer.viewer",
      new TraceEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );
}

export function deactivate(): void {
  manager.disposeAll();
}

async function updateServer(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("dftracer.viewer");
  const custom = cfg.get<string>("serverPath", "").trim();
  if (custom) {
    const choice = await vscode.window.showWarningMessage(
      `DFTracer is using a custom server path:\n${custom}\n\nClear it and download a prebuilt server instead?`,
      { modal: true },
      "Clear and Download",
    );
    if (choice !== "Clear and Download") return;
    await cfg.update("serverPath", "", vscode.ConfigurationTarget.Global);
  }
  clearServerCache(context);
  manager.disposeAll();
  if (activeViewer?.hasTrace()) {
    await activeViewer.reopen();
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "DFTracer: updating server" },
      (progress) => resolveServerBinary(context, (m) => progress.report({ message: m })),
    );
    void vscode.window.showInformationMessage("dftracer_server updated.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Update server failed: ${msg}`);
    const showLogs = "Show Logs";
    void vscode.window
      .showErrorMessage(`Failed to update dftracer_server: ${msg}`, showLogs)
      .then((c) => c === showLogs && log.show());
  }
}

async function selectServer(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("dftracer.viewer");
  const current = cfg.get<string>("serverPath", "").trim();
  const release = cfg.get<string>("serverRelease", "latest") || "latest";
  const usingPrebuilt = !current;

  const DOWNLOAD = "$(cloud-download) Use latest prebuilt server";
  const VERSION = "$(versions) Choose a specific version...";
  const BROWSE = "$(folder-opened) Select a dftracer_server binary...";
  const ENTER = "$(edit) Enter server path...";
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: DOWNLOAD,
        description: usingPrebuilt && release === "latest" ? "current" : "",
        detail: "Download and cache the newest prebuilt server for your platform",
      },
      {
        label: VERSION,
        description: usingPrebuilt && release !== "latest" ? `current: ${release}` : "",
        detail: "Pick a specific prebuilt release to download",
      },
      { label: BROWSE, detail: "Pick a dftracer_server executable from disk" },
      {
        label: ENTER,
        description: current || undefined,
        detail: "Type or paste a path to a dftracer_server executable",
      },
    ],
    {
      title: "DFTracer: Select Server",
      placeHolder: current ? `Current: ${current}` : `Current: prebuilt (${release})`,
    },
  );
  if (!pick) return;

  if (pick.label === VERSION) {
    await selectServerRelease(context);
    return;
  }

  let newPath: string | undefined;
  if (pick.label === DOWNLOAD) {
    newPath = "";
    // Reset to latest so the label matches what gets downloaded.
    if (release !== "latest") {
      await cfg.update("serverRelease", "latest", vscode.ConfigurationTarget.Global);
    }
  } else if (pick.label === BROWSE) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Select dftracer_server",
      title: "Select a dftracer_server binary",
      // Browse the remote host in Remote-SSH, where the server must run.
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!picked?.[0]) return;
    newPath = picked[0].fsPath;
  } else {
    const entered = await vscode.window.showInputBox({
      title: "dftracer_server path",
      value: current,
      prompt: "Absolute path to a dftracer_server executable",
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return undefined; // empty = fall back to the prebuilt server
        return fs.existsSync(t) ? undefined : "No file at that path.";
      },
    });
    if (entered === undefined) return;
    newPath = entered.trim();
  }

  await cfg.update("serverPath", newPath, vscode.ConfigurationTarget.Global);
  log.info(`Server source: ${newPath || "prebuilt (downloaded)"}`);
  manager.disposeAll(); // running servers used the old binary
  if (activeViewer?.hasTrace()) await activeViewer.reopen();
  void vscode.window.showInformationMessage(
    newPath ? `DFTracer server: ${newPath}` : "DFTracer will use the prebuilt server.",
  );
}

async function selectServerRelease(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("dftracer.viewer");
  const current = cfg.get<string>("serverRelease", "latest") || "latest";

  interface ReleaseItem extends vscode.QuickPickItem {
    tag: string;
  }
  const items: ReleaseItem[] = [
    {
      label: "$(cloud) latest",
      description: current === "latest" ? "current" : "",
      detail: "Always download the newest release",
      tag: "latest",
    },
  ];

  let releases;
  try {
    releases = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "DFTracer: fetching versions..." },
      () => listReleases(),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to list server versions: ${msg}`);
    return;
  }

  for (const r of releases) {
    const date = r.publishedAt ? r.publishedAt.slice(0, 10) : "";
    const badges = [
      r.prerelease ? "$(beaker) prerelease" : "",
      r.hasAssetForPlatform ? "" : "$(warning) no build for this platform",
    ]
      .filter(Boolean)
      .join("  ");
    items.push({
      label: r.tag === current ? `$(check) ${r.tag}` : r.tag,
      description: [date, r.tag === current ? "current" : ""].filter(Boolean).join("  "),
      detail: badges || undefined,
      tag: r.tag,
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: "DFTracer: Select Server Version",
    placeHolder: `Current: ${current}`,
    matchOnDescription: true,
  });
  if (!pick || pick.tag === current) return;

  await cfg.update("serverRelease", pick.tag, vscode.ConfigurationTarget.Global);
  log.info(`Server release set to ${pick.tag}`);

  const custom = cfg.get<string>("serverPath", "").trim();
  if (custom) {
    void vscode.window.showWarningMessage(
      `Server version set to ${pick.tag}, but a custom server path is configured and takes ` +
        `precedence. Run "DFTracer: Select Server" to clear it and use the prebuilt server.`,
    );
    return;
  }

  await updateServer(context);
}

async function openLogFile(): Promise<void> {
  const uri = logFileUri();
  if (uri) await vscode.window.showTextDocument(uri);
  else log.show();
}

async function setServerLogLevel(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("dftracer.viewer");
  const current = cfg.get<string>("serverLogLevel", "default");
  const pick = await vscode.window.showQuickPick(
    SERVER_LOG_LEVELS.map((l) => ({
      label: l,
      description: l === current ? "current" : l === "default" ? "server default" : "",
    })),
    { title: "DFTracer: Set Server Log Level", placeHolder: `Current: ${current}` },
  );
  if (!pick) return;
  await cfg.update("serverLogLevel", pick.label, vscode.ConfigurationTarget.Global);
  log.info(`Server log level: ${pick.label}`);
  manager.disposeAll();
  if (activeViewer?.hasTrace()) await activeViewer.reopen();
}

async function openFromCommand(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "dftracer.viewer",
    "DFTracer Viewer",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  const viewer = new Viewer(context, panel);
  if (uri) {
    const { traceDir, file } = await resolveTarget(uri);
    void viewer.show(traceDir, file);
  } else {
    void viewer.show();
  }
}

class TraceEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private context: vscode.ExtensionContext) {}
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }
  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    const viewer = new Viewer(this.context, webviewPanel);
    await viewer.show(path.dirname(document.uri.fsPath), document.uri.fsPath);
  }
}

// A file target scopes the viewer to that file; a folder shows the whole run.
async function resolveTarget(uri: vscode.Uri): Promise<{ traceDir: string; file?: string }> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) return { traceDir: uri.fsPath };
  } catch {
    /* fall through to file handling */
  }
  return { traceDir: path.dirname(uri.fsPath), file: uri.fsPath };
}

class Viewer {
  private traceDir?: string;
  private lastDir?: string;
  private lastFile?: string;
  private disposed = false;

  constructor(
    private context: vscode.ExtensionContext,
    private panel: vscode.WebviewPanel,
  ) {
    activeViewer = this;
    panel.onDidDispose(() => {
      this.disposed = true;
      if (activeViewer === this) activeViewer = undefined;
      this.release();
    });
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) activeViewer = this;
    });
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  hasTrace(): boolean {
    return !!this.lastDir;
  }

  async reopen(): Promise<void> {
    if (this.lastDir) await this.openViewer(this.lastDir, this.lastFile);
  }

  async show(traceDir?: string, file?: string): Promise<void> {
    this.lastDir = traceDir;
    this.lastFile = file;
    if (!traceDir) {
      this.panel.webview.html = loadScreenHtml(
        "Open a DFTracer trace to begin.",
        file,
        false,
        this.serverPath(),
      );
      return;
    }
    // First run with no server configured or cached: let the user choose.
    if (!this.serverPath() && !hasCachedServer(this.context)) {
      this.panel.title = `DFTracer: ${path.basename(file ?? traceDir)}`;
      this.panel.webview.html = chooserHtml(file);
      return;
    }
    await this.openViewer(traceDir, file);
  }

  private async openViewer(traceDir: string, file?: string): Promise<void> {
    this.panel.title = `DFTracer: ${path.basename(file ?? traceDir)}`;
    // Release before acquiring: reopening the same trace would otherwise
    // release the server we just started and connect to a dead port.
    this.release();
    try {
      const port = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "DFTracer Viewer",
          cancellable: false,
        },
        async (progress) => {
          const report = (message: string) => progress.report({ message });
          const binary = await resolveServerBinary(this.context, report);
          if (this.disposed) throw new Error("cancelled");
          report("Starting dftracer_server...");
          const p = await manager.acquire(traceDir, binary);
          this.traceDir = traceDir; // we now hold this server's reference
          return p;
        },
      );
      if (this.disposed) {
        this.release();
        return;
      }
      const ext = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${port}`));
      const apiBase = `${ext.scheme}://${ext.authority}`;
      const html = await fetchServerHtml(port);
      if (this.disposed) {
        this.release();
        return;
      }
      this.panel.webview.html = bakeHtml(html, apiBase, file ?? "");
    } catch (err) {
      if (this.disposed) return;
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to open ${file ?? traceDir}: ${msg}`);
      this.panel.webview.html = loadScreenHtml(msg, file, true, this.serverPath());
    }
  }

  private serverPath(): string {
    return vscode.workspace
      .getConfiguration("dftracer.viewer")
      .get<string>("serverPath", "")
      .trim();
  }

  private async onMessage(m: { type?: string; mode?: string; path?: string }): Promise<void> {
    if (m.type === "pickTrace") {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: m.mode === "file",
        canSelectFolders: m.mode === "dir",
        canSelectMany: false,
        openLabel: "Open DFTracer trace",
        // Workspace URI carries the remote scheme, so the dialog browses the host.
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      if (!picked?.[0]) return;
      const { traceDir, file } = await resolveTarget(picked[0]);
      await this.show(traceDir, file);
    } else if (m.type === "download") {
      if (this.lastDir) await this.openViewer(this.lastDir, this.lastFile);
    } else if (m.type === "setServerPath") {
      await vscode.workspace
        .getConfiguration("dftracer.viewer")
        .update("serverPath", (m.path ?? "").trim(), vscode.ConfigurationTarget.Global);
      await this.show(this.lastDir, this.lastFile);
    } else if (m.type === "retry") {
      await this.show(this.lastDir, this.lastFile);
    } else if (m.type === "updateServer") {
      await updateServer(this.context);
    } else if (m.type === "selectRelease") {
      await selectServerRelease(this.context);
    } else if (m.type === "settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "dftracer.viewer");
    }
  }

  private release(): void {
    if (this.traceDir) {
      manager.release(this.traceDir);
      this.traceDir = undefined;
    }
  }
}

// Inject runtime config + a CSP so the served page runs in the webview.
function bakeHtml(html: string, apiBase: string, file: string): string {
  let origin = "";
  try {
    if (apiBase) origin = new URL(apiBase).origin;
  } catch {
    /* ignore */
  }
  const connect = ["http://localhost:*", "http://127.0.0.1:*", origin].filter(Boolean).join(" ");
  const csp = [
    "default-src 'none'",
    "img-src data:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    `connect-src ${connect}`,
  ].join("; ");
  const config = { apiBase, file, token: "", vscode: true, error: "" };
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />` +
    `<script>window.__DFTRACER__=${json};</script>`;
  return html.replace(/<head[^>]*>/i, (m) => m + head);
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// Matches the timeline viewer: warm near-black, amber, monospace.
const SHELL_STYLES = `
  * { box-sizing: border-box; }
  :root {
    --bg:#0a0b0a; --panel:#0c0e0b; --elev:#12140f; --border:#262920;
    --text:#d6d3c0; --text-hi:#e6e2ce; --muted:#8a927c; --dim:#5f6a53;
    --accent:#e6a13c; --accent-dim:rgba(230,161,60,0.13); --ink:#0a0b0a;
    --danger:#e5807a;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  html, body { height:100%; margin:0; }
  body {
    background:
      radial-gradient(120% 60% at 50% -10%, rgba(230,161,60,0.06), transparent 60%),
      var(--bg);
    color:var(--text); font-family:var(--mono); -webkit-font-smoothing:antialiased;
    display:flex; align-items:center; justify-content:center; padding:28px;
  }
  .card {
    width:100%; max-width:430px;
    background:linear-gradient(180deg, var(--panel), #090a08);
    border:1px solid var(--border); border-radius:12px; padding:26px 26px 22px;
    box-shadow:0 24px 60px -22px rgba(0,0,0,0.75);
    animation:rise .38s ease both;
  }
  @keyframes rise { from{opacity:0; transform:translateY(6px);} to{opacity:1; transform:none;} }
  .strip { display:flex; gap:3px; align-items:flex-end; height:18px; margin-bottom:18px; }
  .strip i { width:3px; background:var(--accent); border-radius:1px; opacity:.5; }
  .strip.live i { animation:blink 1.2s ease-in-out infinite; }
  @keyframes blink { 0%,100%{opacity:.22;} 50%{opacity:.85;} }
  .brand { display:flex; align-items:baseline; gap:9px; }
  .word { font-size:19px; letter-spacing:.05em; color:var(--text-hi); }
  .word b { color:var(--accent); font-weight:400; }
  .tag { color:var(--muted); font-size:11px; letter-spacing:.16em; text-transform:uppercase; }
  .msg { margin:16px 0 0; color:var(--muted); font-size:13px; line-height:1.6; white-space:pre-wrap; }
  .msg.err { color:var(--danger); }
  .file { margin-top:13px; padding:8px 11px; background:var(--elev); border-left:2px solid var(--accent);
    border-radius:4px; color:var(--text); font-size:12px; word-break:break-all; }
  .actions { margin-top:22px; display:flex; flex-direction:column; gap:9px; }
  .btn { font-family:var(--mono); font-size:13px; padding:10px 14px; border-radius:7px; cursor:pointer;
    border:1px solid transparent; text-align:center; transition:.14s ease; }
  .btn.primary { background:var(--accent); color:var(--ink); }
  .btn.primary:hover { filter:brightness(1.06); box-shadow:0 6px 22px -8px rgba(230,161,60,0.5); }
  .btn.ghost { background:transparent; color:var(--text); border-color:var(--border); }
  .btn.ghost:hover { border-color:var(--accent); color:var(--accent); }
  .hint { margin:5px 2px 0; color:var(--dim); font-size:11px; line-height:1.5; }
  .or { display:flex; align-items:center; gap:10px; margin:20px 0 13px;
    color:var(--dim); font-size:10px; letter-spacing:.16em; text-transform:uppercase; }
  .or::before, .or::after { content:""; flex:1; height:1px; background:var(--border); }
  .row { display:flex; gap:8px; }
  .row.wrap { flex-wrap:wrap; }
  .input { flex:1; min-width:0; font-family:var(--mono); font-size:12px; padding:9px 11px;
    background:var(--elev); border:1px solid var(--border); border-radius:7px; color:var(--text); }
  .input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
  .input::placeholder { color:var(--dim); }
  .btn:focus-visible, .input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  @media (prefers-reduced-motion:reduce) { .card,.strip.live i { animation:none; } }
`;

const TICKS = [
  6, 10, 4, 13, 8, 5, 12, 7, 18, 9, 4, 11, 6, 15, 8, 5, 10, 14, 4, 9, 7, 16, 6, 11, 5, 8,
];

function strip(live = false): string {
  const bars = TICKS.map((h) => `<i style="height:${h}px"></i>`).join("");
  return `<div class="strip${live ? " live" : ""}">${bars}</div>`;
}

function brand(): string {
  return `<div class="brand"><span class="word">df<b>tracer</b></span><span class="tag">trace viewer</span></div>`;
}

const CLICK_SCRIPT = `
  const api = acquireVsCodeApi();
  const val = () => (document.getElementById("server-path") || {}).value?.trim() || "";
  document.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const a = b.getAttribute("data-act");
      if (a === "file" || a === "dir") api.postMessage({ type: "pickTrace", mode: a });
      else if (a === "save-path") api.postMessage({ type: "setServerPath", path: val() });
      else api.postMessage({ type: a });
    }),
  );
`;

function page(inner: string): string {
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /><style>${SHELL_STYLES}</style></head>
  <body><div class="card">${inner}</div><script>${CLICK_SCRIPT}</script></body>
</html>`;
}

function loadScreenHtml(message: string, file?: string, isError = false, serverPath = ""): string {
  return page(`
    ${strip()}
    ${brand()}
    <p class="msg${isError ? " err" : ""}">${escHtml(message)}</p>
    ${file ? `<div class="file">${escHtml(file)}</div>` : ""}
    <div class="row wrap" style="margin-top:20px;">
      <button class="btn ghost" data-act="file">Open trace file</button>
      <button class="btn ghost" data-act="dir">Open trace folder</button>
      ${isError ? '<button class="btn ghost" data-act="retry">Retry</button>' : ""}
      ${isError ? '<button class="btn ghost" data-act="updateServer">Update server</button>' : ""}
      ${isError ? '<button class="btn ghost" data-act="selectRelease">Choose version…</button>' : ""}
      <button class="btn ghost" data-act="settings">Settings</button>
    </div>
    <div class="or">or use your own build</div>
    <div class="row">
      <input id="server-path" class="input" type="text" placeholder="/path/to/dftracer_server" value="${escHtml(serverPath)}" />
      <button class="btn ghost" data-act="save-path">Use</button>
    </div>
  `);
}

function chooserHtml(file?: string): string {
  return page(`
    ${strip()}
    ${brand()}
    <p class="msg">This trace opens in dftracer_server. Download a prebuilt server for your platform, or point at a build you already have.</p>
    ${file ? `<div class="file">${escHtml(file)}</div>` : ""}
    <div class="actions">
      <button class="btn primary" data-act="download">Download prebuilt server</button>
      <button class="btn ghost" data-act="selectRelease">Choose version…</button>
    </div>
    <p class="hint">Fetched for macOS or Linux and cached. Pick a specific release with <b>Choose version…</b>, or swap it later with <b>DFTracer: Update Server</b>.</p>
    <div class="or">or use your own build</div>
    <div class="row">
      <input id="server-path" class="input" type="text" placeholder="/path/to/dftracer_server" />
      <button class="btn ghost" data-act="save-path">Use</button>
    </div>
  `);
}
