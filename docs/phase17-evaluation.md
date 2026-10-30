# Phase 17 — Research-grade evaluation dataset

## Scope and labels

Phase 17 separates analyzer regression checks from exploratory kernel source
measurements. The versioned case manifest is
[`evaluation/dataset-v1.json`](../evaluation/dataset-v1.json). Every case has
an ID, input/revision, expected behavior, rationale, evidence, validation
method, and limitations. Controlled cases are development regressions; they
are not an independent final-test set. This avoids tuning and then presenting
the same fixtures as independent accuracy evidence.

The controlled set contains two positive cycle cases, two negative cases, and
two edge cases for irqsave macros and interprocedural symbolic identities. The
assertions are drawn from existing tests and are executed against the current
analyzer. They check the documented outcomes, not statistical quality. The
dataset currently has **zero independently verified Linux deadlock labels**.
No precision, recall, false-positive rate, or false-negative rate is therefore
computed.

The real-source group contains five Linux stable v6.6.87 e1000e files at
`814637ca257f4faf57a73fd4e38888cce88b5911`: `netdev.c`, `ethtool.c`,
`ich8lan.c`, `phy.c`, and `nvm.c`. They are exploratory examples, not positive
or negative ground truth. The choice exercises irqsave use, driver callbacks,
multiple translation units, and a range of file sizes. The saved Phase 15
reports remain available as historical evidence. Phase 17 also reruns the
same five files from the pinned checkout; the results are exploratory and are
not relabeled as ground truth. The checkout is ignored by Git and can be
restored at the exact revision using the commands in the README.

There are no independently documented bug cases in this version. A future
case needs an upstream report or fixing commit, the affected revision and
source path, a traceable lock/context scenario, and evidence that it falls
within IRQGuard's modeled subset. An analyzer warning alone cannot establish
the label. If those conditions cannot be supported, add the case as
exploratory instead of ground truth.

## Reproduce controlled and kernel runs

Build first, then run the Phase 17 dataset evaluator:

```sh
cmake --build build -j2
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87/phase17-rerun \
  --jobs 2
python3 evaluation/run_phase17.py \
  --analyzer build/deadlock-analyzer \
  --output evaluation/results/phase17
```

The script analyzes each distinct controlled C fixture once, checks all eight
case assertions, copies the generated fixture JSON reports, reads the fresh
Phase 17 Linux reports when available (otherwise Phase 15 archived reports),
and writes `summary.json` plus `REPORT.md`. It refuses to
write into a non-empty output directory. Use a new `--output` directory to
preserve prior evidence. It records the analyzer SHA-256 and kernel/toolchain
metadata from the Phase 17 raw measurements when present, otherwise Phase 15.
It copies the raw measurement JSON into the result directory. Per-fixture
elapsed time and peak RSS are measured per analyzer process when GNU
`/usr/bin/time` is available; kernel elapsed time and peak RSS are read from
the kernel runner output. The runner validates the default pinned checkout path if it
exists, but can still summarize archived reports when the source checkout is
absent. Use `--kernel /path/to/linux-v6.6.87` to validate a checkout elsewhere;
a mismatch is recorded and is not silently accepted as the pinned revision.

The checked-in sample run is in
[`evaluation/results/phase17/REPORT.md`](../evaluation/results/phase17/REPORT.md)
and `summary.json`; it includes a copy of the fresh run's raw measurement JSON
and hashes for each per-file report. The runner's Linux rows explicitly say
`fresh_phase17_observation` and `unlabeled_exploratory`. Its fixture pass count
is a test result, not an accuracy score. Full per-file reports are not
duplicated in the sample directory because `netdev.c` JSON exceeds the 16 MiB
upload limit; rerun the documented command to regenerate them.

The kernel command validates the exact revision before building; to check the
pin without running the analysis:

```sh
git -C third_party/linux-v6.6.87 rev-parse HEAD
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87/phase17-rerun \
  --jobs 2
```

`run_kernel_eval.py` refuses a checkout whose commit differs from the pin; it
does not silently update the source. Its output path must be treated as new
evidence and kept distinct from the archived Phase 15 files. If the checkout
is missing, restore tag `v6.6.87`, then verify the commit printed above before
running. See the README for the reproducible source preparation steps.

Run the evaluator integration check with:

```sh
ctest --test-dir build -R evaluation_phase17_dataset --output-on-failure
```

## Fresh Phase 17 Linux results

The fresh five-report aggregate contains 396 function definitions, 12
lock operations (10 acquisitions and 2 releases), 0 lock dependencies, 0
interrupt graph edges, 0 candidate cycles, 43,632 uncertainty events, 4,922
unique uncertainty records, and 2 diagnostics. The per-file rows are in the
generated sample report. Analysis time summed across separate translation
unit runs is 6.993 seconds; maximum reported per-process peak RSS is 240,964
KiB. The kernel object/objtool/ORC validation status is recorded separately
in `kernel-raw-measurements.json`; source analysis does not establish those
build stages.

These figures are actual archived outputs. They do not establish analyzer
accuracy: zero dependencies or cycles may reflect missed extraction,
translation-unit boundaries, unresolved lock identities, or the bounded
model. Uncertainty events and unique records use the analyzer's schema-v4
summary semantics; they are not interchangeable counts.

## Comparison with established Linux tools

| Tool | Method and positive result | Coverage and comparison limits |
|---|---|---|
| IRQGuard | Static AST/CFG and bounded summaries for one translation unit; emits source-derived lock edges/cycle candidates and explicit uncertainty. | Examines parsed paths without requiring runtime execution, but does not model the whole kernel or all aliases, contexts, and build configurations. |
| Linux lockdep (`CONFIG_PROVE_LOCKING`) | Runtime lock validator observes lock acquisition chains, lock classes, IRQ usage/context and reports dependency or IRQ-safety violations. The kernel documentation describes it as runtime validation and emphasizes exercising relevant locking sequences. | Requires an instrumented running kernel and exercised code. It reasons over lock-class/runtime observations; this is not a static-source oracle. Absence of a warning in one run is not evidence of absence. A matching lockdep warning can independently support a candidate, but does not automatically validate the same source-level identity or path assumptions. |
| locktorture | Runtime stress test for selected locking primitives and configurations. | Useful for lock implementation/stress behavior; not a general source-level lock-order detector and not a direct IRQGuard accuracy comparator. |
| KCSAN | Runtime sampling/data-race detector. | Detects a different property (data races), so its findings are not deadlock labels. |

IRQGuard has not been run against lockdep in a dedicated native Linux test
kernel for this dataset. The current WSL evaluation artifacts are bounded
Kbuild/object validation and static analysis; they do not demonstrate a
lockdep run. A meaningful future comparison should record the exact kernel
config, lockdep warnings, exercised test workload and source revision, then
manually map comparable lock classes/functions to static edges. Lockdep should
not be used to mark an unobserved path as negative.

References: [Linux v6.6 lockdep design documentation](https://www.kernel.org/doc/html/v6.6/locking/lockdep-design.html)
and the kernel's [locking selftests](https://www.kernel.org/doc/html/v6.6/dev-tools/testing-overview.html).

## Known evaluation limits

- The synthetic cases are deliberately small and overlap existing regression
  tests; they are not a held-out benchmark or independent oracle.
- No real Linux case has a verified positive or negative ground-truth label.
- The selected source subset is one e1000e revision/configuration, not all
  kernel source or all preprocessor configurations.
- The current saved per-file reports do not create a whole-driver call graph;
  dependencies can be missed across translation units.
- Parser diagnostics and uncertainty remain part of the reported results.
- No isolated native lockdep execution, real IRQ injection, or runtime kernel
  deadlock reproduction is included.
- Timings and memory refer to this saved environment and tool version; they
  are descriptive measurements, not statistically repeated performance
  estimates.
