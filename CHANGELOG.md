# Changelog

## 0.0.1

Initial release.

- Open `.pfw` / `.pfw.gz` traces in an interactive timeline inside VS Code.
- Pan/zoom with density level-of-detail, lanes grouped by host or ordered by
  rank, flamegraph and caller/callee sandwich, gap/idle analysis, I/O bandwidth
  strip, query box, and per-metric help tooltips.
- Downloads a prebuilt `dftracer_server` for the host platform on first use
  (macOS / Linux, x64 / arm64), verifies its checksum, and caches it; renders
  the UI the server serves at `GET /`.
- **Select Server** to choose the prebuilt server, browse for a binary, or type
  a path; **Update Server** to re-download the selected release.
- Logs to a **DFTracer Viewer** output channel with **Show Logs** / **Open Log
  File**, and **Set Server Log Level** for `dftracer_server` verbosity.
- Index built in a temporary directory (removed on close) unless
  `dftracer.viewer.indexDir` is set.
- Works over Remote-SSH / Codespaces; `dftracer.viewer.serverPath` to use a
  local build instead of downloading.
- Machine-scoped settings under `dftracer.viewer.*`.
