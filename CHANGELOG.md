# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.0.3](https://github.com/rayandrew/vscode-dftracer-viewer/compare/v0.0.2...v0.0.3) (2026-07-21)

### Features

- better timeout to notify slow server initialization ([687e7aa](https://github.com/rayandrew/vscode-dftracer-viewer/commit/687e7aabf4d9a0427a2b10fd6bbf907e5d725374))

### Bug Fixes

- e2e CI ([aae6264](https://github.com/rayandrew/vscode-dftracer-viewer/commit/aae6264cbbe3d58b41bde0d649fd3a3e16d1797b))

## [0.0.2](https://github.com/rayandrew/vscode-dftracer-viewer/compare/v0.0.1...v0.0.2) (2026-07-20)

### Features

- add server version picker and wire into `Select Server` ([5d001d2](https://github.com/rayandrew/vscode-dftracer-viewer/commit/5d001d29161ee3f3165e557cb0cc4e7701373e0a))

## 0.0.1 (2026-07-10)

### Features

- initialize dftracer viewer extension ([3897998](https://github.com/rayandrew/vscode-dftracer-viewer/commit/3897998aee01e2a298c3bd19dbb0a87b0356ded6))

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
