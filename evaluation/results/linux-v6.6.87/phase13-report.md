# Phase 13 — Reproducible evaluation and regression results

## Compared artifacts and provenance

This comparison uses the preserved Phase 9.0 data and the post-fix Phase 12
post-install run. The baseline is repository revision
`23f602b2f725ea385cff4d3715e8e1906a52dfee`; the current analyzer source is at
revision `2545d6a85b103ee5b2c5d0f1555d7c860f943be9` with a dirty working tree
(the Phase 13 documentation and comparison files are in progress). Analyzer
SHA-256 values are recorded in the machine-readable comparison artifact.

Both runs use Linux stable `v6.6.87`, commit
`814637ca257f4faf57a73fd4e38888cce88b5911`, five e1000e files (`netdev.c`,
`ethtool.c`, `ich8lan.c`, `phy.c`, `nvm.c`), x86_64 `x86_64_defconfig` with
`CONFIG_E1000E=m`, the same config SHA-256
`488d466afc9efc70b31b8025cb664cb757b6079ba68e57246bb37d5f2d136cd1`, and
Clang/LLVM 20.1.2. The baseline archive did not preserve its compilation
database, so byte-for-byte compiler command equivalence cannot be verified.
The post-fix database has 11 commands because the composite e1000e object is
built to exercise deferred objtool; the five analyzed C translation units are
unchanged.

## Before/after results

| Measure | Phase 9.0 saved baseline | Post-fix Phase 12 run |
| --- | ---: | ---: |
| Translation units / functions | 5 / 396 | 5 / 396 |
| Lock acquisitions / releases | 6 / 6 | 6 / 6 |
| irqsave acquisitions / irqrestore releases | 2 / 2 | 2 / 2 |
| Lock identity statuses | 10 symbolic, 2 unresolved | 12 symbolic |
| Lock dependencies | 6 | 0 |
| Interrupt graph edges | 6 | 0 |
| Candidate cycles | 3 inconclusive | 0 |
| Raw uncertainty events | 43,705 | 43,514 |
| Grouped unique uncertainty records | 4,872 | 4,833 |
| Diagnostics | 2 | 2 |
| Analyzer elapsed time, sum of per-file runs | 6.644 s | 5.790 s |
| Peak RSS, maximum across separate runs | 192,312 KiB | 192,848 KiB |
| Objtool / ORC validation | Explicitly skipped; no ORC metadata | Objtool composite-object check passed; ORC sections present |
| Separate `CONFIG_STACK_VALIDATION` | Not established by legacy record | Not configured by defconfig |

The two irqsave lock identities in the baseline were unresolved macro helper
expressions. The post-fix reports resolve both to symbolic
`&adapter->systim_lock` identities, with source expansion locations retained.
The operation counts stayed constant, so the measurable extraction improvement
is identity/provenance quality rather than a higher operation count.

The three baseline cycles were classified `inconclusive_analysis` and included
unknown lock/context evidence. The post-fix analyzer emits no lock dependencies
or graph edges for this selected analysis and therefore reports no cycles. This
is not evidence that the driver is deadlock-free or that three true deadlocks
were fixed. It is a changed static result that remains limited by the analyzer's
modeled scope and unresolved operations. The cycle change cannot be assigned
to one code change from this aggregate before/after comparison.

The 191-event and 39-record uncertainty decreases are small. Raw events and
grouped records are different measures: a raw warning can propagate through
summaries, while grouped-record deduplication uses heuristic cause/location
keys. The Phase 9.0 unique count was reconstructed by the Phase 10 classifier;
post-fix structured records were emitted directly by schema v4. Neither count
is a number of independently confirmed bugs. No warnings were removed merely
to lower the count.

Timing differs by one run per version and is not a statistically controlled
performance benchmark; the 0.854 second decrease and 536 KiB RSS increase
should not be interpreted as a demonstrated speedup or regression. The two
diagnostics are analyzer CFG event-mapping diagnostics, not parser failures.

## Independent testing

The automated tests include positive and negative source fixtures, malformed
input handling, custom APIs, macro-expanded kernel lock APIs, nested and
interprocedural locking, interrupt-state transitions, feasibility rejection,
uncertainty grouping, cycle-review provenance, unified CLI integration,
frontend API client and evaluation-response rendering, runtime lock scenarios,
and Phase 12 build evidence. Exact commands and results:

```sh
cmake -S . -B build -G Ninja
cmake --build build -j2
ctest --test-dir build --output-on-failure
```

Result: **14/14 CTest tests passed**. This includes Phase 9 lock extraction and
macro regression tests, Phase 10 uncertainty tests, Phase 11 cycle/feasibility
review tests, Phase 12 configuration/evidence checks, runtime tests, malformed
input tests, and full CLI integration.

```sh
cd web
npm test -- --run
npm run build
cd ..
node --check backend/server.mjs
python3 evaluation/test_phase12_evidence.py
python3 evaluation/test_review_cycles.py
python3 evaluation/test_uncertainty_baseline.py \
  evaluation/summarize_uncertainties.py \
  evaluation/results/linux-v6.6.87/reports
```

Results: **16/16 web tests passed**, production Vite/TypeScript build passed,
backend syntax check passed, Phase 12 evidence checks passed, Phase 11 archived
cycle review checks passed, and Phase 10 baseline uncertainty checks reproduced
43,705 events and 4,872 grouped records.

The web tests exercise the evaluation response shape and rendering with a
representative API payload; they do not make a live HTTP request to the Node
backend. The backend passed `node --check`, but a backend-to-browser localhost
round trip was not measured in this environment. The controlled deadlock
fixture runs under its watchdog as part of the CTest runtime test.

## Build validation coverage

The baseline explicitly passed `CONFIG_OBJTOOL=` and an unsupported
`SKIP_STACK_VALIDATION=1`; its object compiler steps ran, but objtool checks,
ORC generation, and separate stack validation were not established. In the
post-install run, `libelf-dev 0.190-1.1ubuntu0.1` enabled `make prepare`. With
`CONFIG_X86_KERNEL_IBT=y`, Linux 6.6 deferred objtool to the composite object.
Kbuild built `e1000e.o`, and its saved command ran objtool with `--orc`, `--ibt`,
`--retpoline`, `--module`, and `--link`; `.orc_unwind` and `.orc_unwind_ip`
sections were verified. The final `.ko` link and full kernel build were not
attempted, and `CONFIG_STACK_VALIDATION` remains unconfigured. See
[Phase 12 report](phase12-report.md) for stage details.

## Ground truth and accuracy limits

The repository has controlled fixtures with expected outcomes and negative
cases. It does not have an independently labeled set of real Linux deadlocks
and non-deadlocks for the analyzed revision. Therefore precision, recall,
false-positive rate, and false-negative rate are **not calculated**. Candidate
counts and changes in candidate counts are not accuracy metrics. The real-kernel
results have not been independently confirmed as bugs; the retained assessment
is limited to source evidence and explicit uncertainty.

## Reproduction

Starting with the documented Ubuntu 24.04 / WSL 2 prerequisites and a pinned
Linux checkout, run:

```sh
cmake -S . -B build -G Ninja
cmake --build build -j2
ctest --test-dir build --output-on-failure
python3 evaluation/run_kernel_eval.py \
  --kernel /tmp/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87/phase13-rerun \
  --jobs 2
python3 evaluation/compare_phase13.py
```

The kernel source must be at the recorded commit, and `libelf-dev` is needed
for objtool. `lld-20` is not needed because the runner selects GNU `HOSTLD`.
The runner validates selected objects and the deferred composite-object
objtool pass; it does not build the full kernel or link/load a module. The
comparison script checks source revision, file list, and config hash before
creating [`phase13-before-after.json`](phase13-before-after.json). The original
baseline data is preserved under [`../../baselines/phase9.0`](../../baselines/phase9.0).
