import * as vscode from "vscode";
import * as fs from "fs";

const channel = vscode.window.createOutputChannel("DFTracer Viewer", { log: true });

// Mirrored to a known file path (VS Code's own channel log is buried under
// output_logging_*) so users can attach it via "DFTracer: Open Log File".
let stream: fs.WriteStream | undefined;
let fileUri: vscode.Uri | undefined;

export function initLogFile(context: vscode.ExtensionContext): void {
  try {
    fs.mkdirSync(context.logUri.fsPath, { recursive: true });
    fileUri = vscode.Uri.joinPath(context.logUri, "dftracer-viewer.log");
    stream = fs.createWriteStream(fileUri.fsPath, { flags: "a" });
    tee("INFO", `--- session started ${new Date().toISOString()} ---`);
  } catch {
    /* best-effort; the output channel still works */
  }
}

export function logFileUri(): vscode.Uri | undefined {
  return fileUri;
}

function tee(level: string, msg: string): void {
  stream?.write(`${new Date().toISOString()} [${level}] ${msg}\n`);
}

export const log = {
  info: (m: string) => (channel.info(m), tee("INFO", m)),
  debug: (m: string) => (channel.debug(m), tee("DEBUG", m)),
  warn: (m: string) => (channel.warn(m), tee("WARN", m)),
  error: (m: string) => (channel.error(m), tee("ERROR", m)),
  show: () => channel.show(),
  dispose: () => {
    channel.dispose();
    stream?.end();
  },
};
