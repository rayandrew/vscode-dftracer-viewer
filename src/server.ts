import * as vscode from "vscode";
import * as child_process from "child_process";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { log } from "./log";

// One dftracer_server per trace directory, ref-counted across viewer tabs.
interface ServerInstance {
  refs: number;
  proc?: child_process.ChildProcess;
  ready: Promise<number>; // resolves to the listen port
  indexTemp?: string; // ephemeral index dir, removed when the server stops
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface StderrRef {
  text: string;
  lastActivity: number; // Date.now() of the most recent server output line
}

// The newest non-empty line the server logged — the most useful "what is it
// doing right now" signal to surface while we wait for it to come up.
function lastLogLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) return lines[i];
  return "";
}

interface WaitOpts {
  // Give up after this many ms of *silence* (no new server output). A trace
  // that keeps logging progress is never killed, however long it takes.
  // <= 0 means wait indefinitely.
  idleMs: number;
  onProgress?: (message: string) => void;
}

// Probes back off from 250ms so a long index isn't polled hundreds of times,
// capped low enough that we still notice readiness promptly.
const PROBE_DELAY_MIN_MS = 250;
const PROBE_DELAY_MAX_MS = 2000;

// How often progress is refreshed and the idle watchdog is checked. Independent
// of the probes, which can sit waiting on the server for minutes.
const TICK_MS = 250;

function waitReady(
  port: number,
  proc: child_process.ChildProcess,
  stderr: StderrRef,
  opts: WaitOpts,
): Promise<void> {
  const { idleMs, onProgress } = opts;
  const noTimeout = idleMs <= 0;
  return new Promise((resolve, reject) => {
    let done = false;
    // One probe in flight at a time: a probe can fail twice (a timeout is
    // followed by an ECONNRESET), and must still schedule only one retry.
    let retryScheduled = false;
    let delayMs = PROBE_DELAY_MIN_MS;
    const ticker = setInterval(() => tick(), TICK_MS);
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearInterval(ticker);
      fn();
    };
    proc.once("exit", (code) =>
      finish(() =>
        reject(
          new Error(
            `dftracer_server exited (code ${code}) before it was ready. ${stderr.text.slice(-600)}`,
          ),
        ),
      ),
    );
    proc.once("error", (e) =>
      finish(() =>
        reject(
          /ENOENT/.test(e.message)
            ? new Error("dftracer_server binary was not found or is not executable.")
            : e,
        ),
      ),
    );
    const start = Date.now();
    const report = () => {
      if (!onProgress) return;
      const secs = Math.round((Date.now() - start) / 1000);
      const line = lastLogLine(stderr.text);
      onProgress(line ? `${line} (${secs}s)` : `Preparing trace… (${secs}s)`);
    };
    // The watchdog runs on its own clock rather than off the back of a probe,
    // because a probe can legitimately sit unanswered for minutes.
    const tick = () => {
      if (done) return;
      report();
      const idleFor = Date.now() - stderr.lastActivity;
      if (noTimeout || idleFor <= idleMs) return;
      const idleSecs = Math.round(idleFor / 1000);
      const tail = stderr.text.trim().slice(-600);
      finish(() =>
        reject(
          new Error(
            `dftracer_server produced no output for ${idleSecs}s and never became ready — ` +
              `it looks stuck. Adjust the idle limit with ` +
              `'dftracer.viewer.serverStartTimeoutSec' (0 waits indefinitely).` +
              `${tail ? `\n\nLast server output:\n${tail}` : ""}`,
          ),
        ),
      );
    };
    const retry = () => {
      if (done || retryScheduled) return;
      retryScheduled = true;
      setTimeout(tryOnce, delayMs);
      delayMs = Math.min(delayMs * 2, PROBE_DELAY_MAX_MS);
    };
    // Any HTTP reply means the server is up and serving. Waiting for a specific
    // status on a specific API path ties startup to one server version: the
    // /api/v1/info this used to poll 404s on newer builds, so the viewer waited
    // forever on a server that was already answering. Whether the page itself
    // is good is fetchServerHtml's problem, and it reports that as an error
    // rather than hanging. Also no per-request timeout, so a server busy
    // building its activity summary is given as long as it needs.
    const tryOnce = () => {
      if (done) return;
      retryScheduled = false;
      const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        res.resume();
        log.debug(`probe / -> HTTP ${res.statusCode}`);
        finish(resolve);
      });
      req.on("error", (e) => {
        log.debug(`probe / -> ${(e as NodeJS.ErrnoException).code ?? e.message}`);
        retry();
      });
    };
    tryOnce();
  });
}

export class ServerManager {
  private servers = new Map<string, ServerInstance>();

  acquire(
    traceDir: string,
    binary: string,
    onProgress?: (message: string) => void,
    onLog?: (line: string) => void,
  ): Promise<number> {
    let inst = this.servers.get(traceDir);
    if (inst && inst.proc && inst.proc.exitCode === null) {
      inst.refs += 1;
      return inst.ready;
    }
    inst = this.start(traceDir, binary, onProgress, onLog);
    this.servers.set(traceDir, inst);
    return inst.ready;
  }

  private start(
    traceDir: string,
    binary: string,
    onProgress?: (message: string) => void,
    onLog?: (line: string) => void,
  ): ServerInstance {
    const cfg = vscode.workspace.getConfiguration("dftracer.viewer");
    const userIndexDir = cfg.get<string>("indexDir", "").trim();
    const inst: ServerInstance = { refs: 1, ready: Promise.resolve(0) };
    // Ephemeral index removed on stop, so trace folders aren't littered.
    if (!userIndexDir) {
      inst.indexTemp = fs.mkdtempSync(path.join(os.tmpdir(), "dftracer-index-"));
    }
    const indexDir = userIndexDir || inst.indexTemp!;
    inst.ready = (async () => {
      const port = await freePort();
      const extraArgs = cfg.get<string[]>("extraArgs", []) ?? [];
      const logLevel = cfg.get<string>("serverLogLevel", "default");

      const args = ["-d", traceDir, "-p", String(port), "--index-dir", indexDir];
      if (logLevel && logLevel !== "default") args.push("--log-level", logLevel);
      args.push(...extraArgs);

      log.info(`Starting dftracer_server on :${port} (${binary})`);
      log.debug(`args: ${args.join(" ")}`);
      const proc = child_process.spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      inst.proc = proc;
      const stderr: StderrRef = { text: "", lastActivity: Date.now() };
      const forward = (d: Buffer) => {
        const s = d.toString();
        stderr.text += s;
        for (const line of s.split("\n")) {
          if (!line.trim()) continue;
          stderr.lastActivity = Date.now(); // reset the idle watchdog on progress
          log.info(`[server] ${line}`);
          onLog?.(line);
        }
      };
      proc.stdout?.on("data", forward);
      proc.stderr?.on("data", forward);
      proc.on("exit", (code, signal) =>
        log.info(`dftracer_server on :${port} exited (code ${code ?? signal})`),
      );

      const idleMs = Math.round(cfg.get<number>("serverStartTimeoutSec", 120) * 1000);
      await waitReady(port, proc, stderr, { idleMs, onProgress });
      log.info(`dftracer_server ready on :${port}`);
      return port;
    })();
    // Don't let an unobserved rejection crash the extension host.
    inst.ready.catch(() => {
      this.servers.delete(traceDir);
    });
    return inst;
  }

  // Release one reference; the server is stopped when the last viewer closes.
  release(traceDir: string): void {
    const inst = this.servers.get(traceDir);
    if (!inst) return;
    inst.refs -= 1;
    if (inst.refs <= 0) {
      inst.proc?.kill();
      removeIndexTemp(inst);
      this.servers.delete(traceDir);
    }
  }

  // Force-stop the server for a trace regardless of ref count. Used to cancel a
  // still-starting server; killing the process makes the pending waitReady()
  // reject, so the awaiting acquire() call unwinds.
  stop(traceDir: string): void {
    const inst = this.servers.get(traceDir);
    if (!inst) return;
    inst.proc?.kill();
    removeIndexTemp(inst);
    this.servers.delete(traceDir);
  }

  disposeAll(): void {
    for (const inst of this.servers.values()) {
      inst.proc?.kill();
      removeIndexTemp(inst);
    }
    this.servers.clear();
  }
}

function removeIndexTemp(inst: ServerInstance): void {
  if (!inst.indexTemp) return;
  try {
    fs.rmSync(inst.indexTemp, { recursive: true, force: true });
  } catch {
    /* best effort; the OS will reap tmpdir eventually */
  }
  inst.indexTemp = undefined;
}

export function fetchServerHtml(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET / returned ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timed out fetching the viewer page."));
    });
  });
}
