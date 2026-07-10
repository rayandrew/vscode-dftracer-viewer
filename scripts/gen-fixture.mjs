// Generate small DFTracer traces for developing the extension, so F5 has real
// data to open without a dftracer-utils build. Writes several scenarios under
// fixtures/ (gitignored), each a folder of rank_<n>.pfw.gz files:
//   sample/       4 ranks, 3 epochs  - the everyday case
//   large/        16 ranks, 8 epochs - exercises density LOD on a busy timeline
//   single-rank/  1 rank             - the single-file view
// Separate folders also let you test independent vs shared servers.
// Deterministic - no randomness.
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const HOSTS = [
  { name: "node01", hash: "hA" },
  { name: "node02", hash: "hB" },
  { name: "node03", hash: "hC" },
  { name: "node04", hash: "hD" },
];
const BASE_TS = 1_000_000; // indexer treats ts==0 as unset, so start above it

// One rank's file: host + rank metadata, then epochs of compute + a nested
// I/O phase. Children sit inside their parent's [ts, ts+dur] so the server's
// containment depth stacks them under the epoch.
function rankFile(rank, epochs) {
  const pid = 200 + rank;
  const host = HOSTS[rank % HOSTS.length];
  const lines = ["["];
  let id = 1;
  const emit = (o) => lines.push(JSON.stringify({ id: id++, ...o }));
  const ev = (name, cat, ts, dur, args = {}) =>
    emit({ name, cat, pid, tid: pid, ts, dur, ph: "X", args: { hhash: host.hash, ...args } });

  emit({
    name: "HH",
    cat: "HH",
    pid: 0,
    tid: 0,
    ph: "M",
    args: { name: host.name, value: host.hash },
  });
  emit({
    name: "PR",
    cat: "PR",
    pid,
    tid: 0,
    ph: "M",
    args: { name: "rank", value: String(rank) },
  });

  // Stagger each rank's start so lane ordering by rank is visible.
  let t = BASE_TS + rank * 2000;
  for (let e = 0; e < epochs; e++) {
    const epochStart = t;
    ev("epoch", "APP", epochStart, 8000);
    if (e === 0) ev("init", "APP", epochStart + 100, 400);
    ev("compute", "COMPUTE", epochStart + 600, 3000);
    const io = epochStart + 3700;
    ev("io_phase", "APP", io, 4000);
    ev("open", "POSIX", io + 100, 100, { ret: 0 });
    ev("read", "POSIX", io + 300, 800, { ret: 65536 });
    ev("write", "POSIX", io + 1400, 1200, { ret: 32768 });
    ev("close", "POSIX", io + 2800, 100, { ret: 0 });
    t = epochStart + 10000; // small idle gap between epochs
  }
  return lines.join("\n") + "\n";
}

function writeScenario(name, ranks, epochs) {
  const dir = join(FIXTURES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let r = 0; r < ranks; r++) {
    writeFileSync(join(dir, `rank_${r}.pfw.gz`), gzipSync(Buffer.from(rankFile(r, epochs))));
  }
  console.log(`  ${name}: ${ranks} rank(s), ${epochs} epoch(s)`);
}

console.log(`writing fixtures to ${FIXTURES}`);
writeScenario("sample", 4, 3);
writeScenario("large", 16, 8);
writeScenario("single-rank", 1, 5);
