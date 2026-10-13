import * as vscode from "vscode";
import * as https from "https";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as child_process from "child_process";
import { log } from "./log";

const RELEASES_REPO = "llnl-asr/dftracer-utils";
const USER_AGENT = "vscode-dftracer-viewer";

// node platform-arch -> the <platform> token of the asset
// dftracer-utils-<version>-<platform>.tar.gz.
const PLATFORMS: Record<string, string> = {
  "linux-x64": "linux-x86_64",
  "linux-arm64": "linux-aarch64",
  "darwin-arm64": "macos-arm64",
};

function platformToken(): string {
  const plat = PLATFORMS[`${process.platform}-${process.arch}`];
  if (!plat) {
    throw new Error(
      `No prebuilt dftracer_server for ${process.platform}/${process.arch}. ` +
        `Build it yourself and set 'dftracer.viewer.serverPath'.`,
    );
  }
  return plat;
}

interface Release {
  tag: string;
  assets: { name: string; url: string }[];
}

export interface ReleaseInfo {
  tag: string;
  prerelease: boolean;
  publishedAt: string;
  // True when this release ships a prebuilt asset for the current platform.
  hasAssetForPlatform: boolean;
}

// Like platformToken(), but returns null instead of throwing on an
// unsupported platform, so listing can still succeed.
function platformSuffixOrNull(): string | null {
  const plat = PLATFORMS[`${process.platform}-${process.arch}`];
  return plat ? `-${plat}.tar.gz` : null;
}

// List releases from the dftracer-utils repo, newest first.
export async function listReleases(): Promise<ReleaseInfo[]> {
  const url = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`;
  const json = (await httpGetJson(url)) as {
    tag_name?: string;
    prerelease?: boolean;
    published_at?: string;
    assets?: { name: string }[];
  }[];
  if (!Array.isArray(json)) throw new Error("Unexpected response listing releases.");
  const suffix = platformSuffixOrNull();
  return json
    .filter((r) => r.tag_name)
    .map((r) => ({
      tag: r.tag_name as string,
      prerelease: Boolean(r.prerelease),
      publishedAt: r.published_at ?? "",
      hasAssetForPlatform: suffix ? (r.assets ?? []).some((a) => a.name.endsWith(suffix)) : false,
    }));
}

function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" } },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            httpGetJson(res.headers.location).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`GitHub API ${res.statusCode} for ${url}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on("error", reject);
  });
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download ${res.statusCode} for ${url}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

async function fetchText(url: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `dft-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await download(url, tmp);
  const text = await fs.promises.readFile(tmp, "utf8");
  await fs.promises.unlink(tmp).catch(() => {});
  return text;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function extractTarGz(tarball: string, dest: string): Promise<void> {
  // The bundle holds bin/ and lib/ at its top level.
  return new Promise((resolve, reject) => {
    child_process.execFile("tar", ["-xzf", tarball, "-C", dest], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function resolveRelease(): Promise<Release> {
  const which = vscode.workspace
    .getConfiguration("dftracer.viewer")
    .get<string>("serverRelease", "latest");
  const url =
    !which || which === "latest"
      ? `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`
      : `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/${encodeURIComponent(which)}`;
  const json = (await httpGetJson(url)) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  if (!json.tag_name || !json.assets)
    throw new Error(`No dftracer-utils release found (${which}).`);
  return {
    tag: json.tag_name,
    assets: json.assets.map((a) => ({ name: a.name, url: a.browser_download_url })),
  };
}

export function hasCachedServer(context: vscode.ExtensionContext): boolean {
  const root = path.join(context.globalStorageUri.fsPath, "servers");
  try {
    for (const tag of fs.readdirSync(root)) {
      const tagDir = path.join(root, tag);
      if (!fs.statSync(tagDir).isDirectory()) continue;
      for (const plat of fs.readdirSync(tagDir)) {
        if (fs.existsSync(path.join(tagDir, plat, "bin", "dftracer_server"))) return true;
      }
    }
  } catch {
    /* no cache yet */
  }
  return false;
}

// Keep only `keepDir` of `keepTag`. A server running from a removed file keeps
// working (the OS holds the inode until the process exits).
function pruneOtherReleases(
  context: vscode.ExtensionContext,
  keepTag: string,
  keepDir: string,
): void {
  const root = path.join(context.globalStorageUri.fsPath, "servers");
  try {
    for (const tag of fs.readdirSync(root)) {
      const tagDir = path.join(root, tag);
      if (tag !== keepTag) {
        fs.rmSync(tagDir, { recursive: true, force: true });
        continue;
      }
      for (const dir of fs.readdirSync(tagDir)) {
        if (dir !== keepDir) fs.rmSync(path.join(tagDir, dir), { recursive: true, force: true });
      }
    }
  } catch {
    /* nothing cached */
  }
}

export function clearServerCache(context: vscode.ExtensionContext): void {
  fs.rmSync(path.join(context.globalStorageUri.fsPath, "servers"), {
    recursive: true,
    force: true,
  });
}

// Honours serverPath, else downloads + caches the prebuilt for this platform,
// verifying its SHA-256.
export async function resolveServerBinary(
  context: vscode.ExtensionContext,
  report: (message: string) => void,
): Promise<string> {
  const step = (m: string) => {
    report(m);
    log.info(m);
  };
  const override = vscode.workspace
    .getConfiguration("dftracer.viewer")
    .get<string>("serverPath", "")
    .trim();
  if (override) {
    log.info(`Using configured server: ${override}`);
    return override;
  }

  const plat = platformToken();
  const suffix = `-${plat}.tar.gz`;

  step("Resolving prebuilt server release...");
  const release = await resolveRelease();
  const asset = release.assets.find((a) => a.name.endsWith(suffix));
  if (!asset) throw new Error(`Release ${release.tag} has no asset for ${plat}.`);

  // Keyed by the asset, whose name holds the version: a rolling tag such as
  // develop-latest points at a new build over time.
  const assetDir = asset.name.replace(/\.tar\.gz$/, "");
  const cacheDir = path.join(context.globalStorageUri.fsPath, "servers", release.tag, assetDir);
  const binary = path.join(cacheDir, "bin", "dftracer_server");
  // Keep only the release we're about to use, so old downloads don't pile up.
  pruneOtherReleases(context, release.tag, assetDir);
  if (fs.existsSync(binary)) {
    log.info(`Using cached server ${asset.name} (${release.tag})`);
    return binary;
  }

  await fs.promises.mkdir(cacheDir, { recursive: true });
  const tarball = path.join(cacheDir, asset.name);

  step(`Downloading ${asset.name} (${release.tag})...`);
  await download(asset.url, tarball);

  const sums = release.assets.find((a) => a.name === "SHA256SUMS");
  if (sums) {
    step("Verifying checksum...");
    const text = await fetchText(sums.url);
    const want = text
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find((p) => p[1] === asset.name)?.[0];
    const got = await sha256(tarball);
    if (want && want.toLowerCase() !== got.toLowerCase()) {
      await fs.promises.rm(tarball, { force: true });
      throw new Error(`Checksum mismatch for ${asset.name}.`);
    }
  }

  step("Extracting server...");
  await extractTarGz(tarball, cacheDir);
  await fs.promises.rm(tarball, { force: true });
  if (!fs.existsSync(binary))
    throw new Error(`Extracted archive has no dftracer_server (${asset.name}).`);
  await fs.promises.chmod(binary, 0o755);
  log.info(`Server ready: ${binary}`);
  return binary;
}
