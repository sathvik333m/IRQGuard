# Phase 18 — Evidence integration and semantic comparison

Phase 18 connects the existing analyzer, runtime collector, saved reports, and Phase 17 evaluation in the current GUI. It does not change the C++ analysis engine or infer deadlocks from runtime traces.

## Saved analysis reports

The bundled analyzer currently emits schema 4, and the backend now checks for schema 4 on new runs. The browser accepts report schemas 3 and 4, validates collection and graph shapes, and normalizes omitted collections to empty lists. Unsupported schema versions and malformed arrays or graph objects produce an error state; the GUI does not fall back to parsing terminal output. Older schema 3 reports remain readable, but fields that were not recorded (for example categorized uncertainty) remain unavailable.

New analysis history entries record SHA-256 fingerprints for the source, optional `compile_commands.json`, optional API registry, and analyzer executable. Kernel revision and toolchain are left explicitly unknown for interactive source runs because the backend does not establish those facts. Old saved runs have no fingerprints. Their semantic diffs are marked **input comparability unknown**, not equivalent.

## Comparing saved reports

In **Analysis history**, select two completed runs and choose **Compare report semantics**. The comparator normalizes ordering and compares dependency direction, lock identity, context, function endpoints, source provenance, finding cycle/classification, uncertainty event/category counts, and diagnostics. Input hashes and schema versions affect the comparability label. Kernel revision and toolchain are shown only if recorded in the report metadata.

An edge is matched by its directed semantic key. Lock-identity changes are paired using context/function and source-location anchors and are not double-counted as an unrelated added and removed edge. Finding cycles are matched by normalized lock/context rotation. These are pragmatic matching rules, not a proof that findings across different source versions refer to the same execution. A source or schema mismatch is displayed; absent hashes produce an unknown label. Kernel revision and toolchain data appear only when reports contain them. Build-validation stages are not part of the analyzer report contract, so the semantic comparison does not infer those stages; they are shown only in the separately sourced evaluation record. The GUI never interprets a changed or removed finding as proof of a fixed bug.

## Runtime observations

The Runtime Evidence page displays events from the controlled userspace pthread harness with run ID, creation time, trace schema, event sequence, thread, lock identifier, and monotonic timestamp where available. A manually supplied exact lock-identity mapping is required to associate a userspace lock with a static candidate. Comparisons retain the candidate, selected trace run IDs, matched/required order edges, and the collector's status.

`watchdog_deadlock_reproduced_in_controlled_process` means the disposable test process exhibited a persistent wait-for cycle until its watchdog terminated it. An observed lock-order cycle without a persistent wait-for cycle is reported separately. Missing events mean **not observed**, not disproven. These userspace traces do not model hardware interrupts, so hard-IRQ findings are marked not comparable. A trace or static candidate alone is not independent confirmation of a kernel deadlock.

When runtime tools are unavailable, the page shows the backend capability state and no fabricated trace. Empty completed traces have a separate empty state. Backend errors are surfaced in the page.

## Evaluation evidence

The Kernel evaluation page now includes the Phase 17 dataset record alongside archived Phase 6/15/16 material: pinned release and commit, analyzer/config fingerprints, controlled assertion results, per-file exploratory measurements, uncertainty totals, and build-validation stages. Exploratory Linux files are explicitly unlabelled. Zero dependencies or cycles are not evidence that the kernel is deadlock-free. Precision and recall remain unavailable without independently labeled kernel bug cases. A successful object/objtool/ORC check does not claim a full kernel or final module build, and separately configured stack validation remains identified as such.

Rerun the controlled assertions and summarize the available pinned-source measurements from the repository root (the output directory must be empty):

```sh
python3 evaluation/run_phase17.py --analyzer build/deadlock-analyzer \
  --kernel third_party/linux-v6.6.87 --output /tmp/irqguard-phase17
ctest --test-dir build -R evaluation_phase17_dataset --output-on-failure
```

This runner validates the pinned checkout and executes controlled fixtures; it summarizes saved per-file kernel reports and does not itself reanalyze kernel files. For a fresh analysis, first run `python3 evaluation/run_kernel_eval.py --kernel third_party/linux-v6.6.87 --analyzer build/deadlock-analyzer --llvm /usr/lib/llvm-20/bin --output /tmp/irqguard-kernel-rerun --jobs 2`, then pass that run's `raw-measurements.json` and `reports` directory as `--kernel-raw` and `--kernel-reports-dir` to `run_phase17.py`. Both scripts validate pins and fail instead of silently changing revisions. See [the Phase 17 evaluation report](../evaluation/results/phase17/REPORT.md) and [dataset guide](phase17-evaluation.md) for recorded evidence and limitations.

## Test and build

```sh
cd web
npm test -- --run
npm run build
```

```sh
cd ..
node --check backend/server.mjs
cmake --build build -j2
ctest --test-dir build --output-on-failure
```

The frontend suite covers report schema handling, graph/finding behavior, history deletion, semantic diff normalization and changes, evaluation display, and empty/error states. The backend currently has no isolated HTTP route test harness; `node --check` validates syntax, while live HTTP integration requires running the local service in a permitted environment.

## Known limits

- Interactive reports do not currently record a verified kernel commit or compiler toolchain; this is shown as unavailable.
- Source fingerprints are captured when an analysis is queued, but do not prove that all environmental inputs affecting Clang were captured.
- Semantic matching is location-anchored and may not correlate moved code across revisions.
- Runtime-to-static associations require explicit user mappings and remain userspace-only.
- Evaluation rows are counts and measurements, not accuracy metrics or confirmed kernel bugs.
