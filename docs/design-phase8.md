# Phase 8: Local graphical interface

## Scope

Phase 8 adds an optional local React/TypeScript interface and a small Node.js adapter around the existing C++ analyzer. The adapter consumes the analyzer's JSON output (currently schema version 3) directly. It does not scrape terminal text, alter analyzer findings, or provide a second analysis implementation. It is not part of Archerfish and does not claim full kernel support.

## Components

- `web/`: Vite, React, TypeScript, Tailwind CSS, React Flow and Recharts. The interface provides overview, analysis submission, local history, comparison, graph, findings, source browsing, and settings views.
- `backend/server.mjs`: versioned HTTP API. It validates requests, invokes the analyzer with a fixed argument vector (never a shell command), enforces resource limits, stores run metadata in JSON and reports as JSON files, and serves bounded source ranges.
- Existing `build/deadlock-analyzer`: C++ Clang analyzer. It remains usable independently from the GUI.

## Analyzer data mapping

The UI accepts `schema_version: 3` and `schema_version: 4` with `analysis_kind: interrupt_aware_lock_analysis`. Schema 4 adds structured uncertainty summaries and records; schema 3 remains accepted for saved history. It uses `functions` and `calls` for source navigation, `api_operations` for lock events, `lock_dependencies` and `interrupt_lock_graph` for relationships, and `interrupt_cycles` for findings. The backend summary counts are computed from those real arrays. A missing optional report array is shown as empty; malformed arrays and unsupported schema versions produce visible errors. The backend measures wall duration around the analyzer process because the analyzer report does not contain duration. Its health endpoint detects the local OS and WSL status; analyzer build version and target kernel are reported as unknown because the analyzer does not expose them.

The graph uses the report's lock identities and graph edges. Candidate edges are highlighted when their finding is selected; normal lock-order, interrupt, and rejected relationships have distinct styles. Lock API filters are populated only for identities that exactly match a lock identity in `api_operations`; unmatched identities remain unknown. Edge details preserve contexts and locations, and the finding inspector carries explanation and provenance supplied by the analyzer. The overview's API mix groups actual lock-bearing API events, not inferred object lock types or severity. The source endpoint serves only paths referenced in the stored report and still under configured workspace roots. It returns a limited line range, not an uploaded or copied source file.

## HTTP contract

All routes are under `/api/v1`:

- `GET /health`: analyzer path/availability, allowed roots, report schema and explicit availability of runtime and benchmark capabilities.
- `GET /evaluations/linux-v6.6.87`: read-only summary of the pinned Phase 6 result from `evaluation/results/linux-v6.6.87/raw-measurements.json`; exposes aggregate and per-translation-unit measurements and the recorded build limitations.
- `GET /analyses?limit=N`: most recent run metadata.
- `POST /analyses`: queue a run using `source_path` and optional compilation database/API registry paths.
- `GET /analyses/{id}`: poll run state and metadata.
- `GET /analyses/{id}/report`, `/findings`, `/graph`: report views derived from the persisted analyzer JSON.
- `GET /analyses/{id}/source?file=...&line=...&context=...`: bounded source snippet for a report-referenced path.

## Filesystem and process boundary

The API defaults its workspace root to the repository. `IRQGUARD_WORKSPACES` can list additional existing roots separated by the platform path separator. Paths must be absolute; the service resolves symlinks before checking containment. Only C/header source paths, compilation databases and JSON API config files are accepted. The source size limit is 20 MiB; stdout and stderr are independently capped at 16 MiB; runs time out after 180 seconds by default and at most two are active at once. These are local development safeguards, not a hardened multi-user service boundary.

The service binds to `127.0.0.1` in the documented command and allows only the local Vite development/preview origins. Keep it loopback-only. The browser cannot directly browse WSL paths, so users enter an absolute Linux path. The service stores report JSON and history below `IRQGUARD_DATA_DIR` (default `~/.local/share/irqguard`) but does not copy source files. History is kept in `history.json`; report files are local and currently have no retention or deletion interface. SQLite history from the retired Python adapter is not imported automatically.

## Limitations and unavailable capabilities

- The adapter accepts one C translation unit per run; using a compilation database supplies flags but does not automatically schedule a whole kernel build.
- The report adapter supports schema 3 historical reports and schema 4 current reports; future versions require an intentional UI update.
- The dashboard can show host OS and WSL detection, but the analyzer does not report its build version or a target kernel version. These stay marked unavailable.
- The report provides heuristic uncertainty severity, not a calibrated risk score. It does not provide a lock-object type for every graph node or live progress events, and the UI does not create chronological process logs.
- API config paths are supported. Arbitrary Clang flags and shell commands are not exposed in the GUI.
- Source references outside the workspace or no longer present cannot be displayed.
- Static findings remain candidates/inconclusive results according to analyzer categories, not confirmed deadlocks.
- Runtime instrumentation/evidence comparison is not implemented. Benchmark runs, peak-memory collection, and accuracy/scalability result dashboards are not implemented. The UI reports these as unavailable rather than fabricating values.
- History comparison shows saved metadata and warns about schema differences; it does not normalize or semantically compare finding sets.
- The Kernel evaluation page displays one pinned five-file Linux `v6.6.87` evaluation snapshot. It is not a kernel source browser and does not broaden the C++ analyzer's supported language, build configurations, or kernel coverage.

## Development commands

From repository root, with C++ prerequisites installed:

```sh
cmake -S . -B build -G Ninja
cmake --build build
cd backend
npm start
```

In a second terminal:

```sh
cd web
npm ci
npm run dev
```

Checks:

```sh
ctest --test-dir build --output-on-failure
cd web
npm test
npm run build
```

The API binds to loopback. See the README for Ubuntu/WSL 2 setup and workspace configuration details.
