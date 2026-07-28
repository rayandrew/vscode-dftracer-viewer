// Print one version's section of CHANGELOG.md, for `gh release create --notes-file`.
// Usage: node scripts/release-notes.mjs 0.0.5
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!version) {
  console.error("usage: release-notes.mjs <version>");
  process.exit(2);
}

const changelog = join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
const lines = readFileSync(changelog, "utf8").split("\n");

// Headings are either "## [0.0.5](compare-url) (date)" or "## 0.0.1 (date)".
const isVersionHeading = (line) => /^## /.test(line);
const headingVersion = (line) => line.match(/^## \[?([0-9][^\]\s]*)\]?/)?.[1];

const start = lines.findIndex((l) => isVersionHeading(l) && headingVersion(l) === version);
if (start === -1) {
  console.error(`no CHANGELOG.md section for ${version}`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex(isVersionHeading);
const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

console.log(body);
