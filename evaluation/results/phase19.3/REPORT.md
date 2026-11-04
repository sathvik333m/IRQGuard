# Linux Kernel Feasibility Evaluation

## Result

The fresh analysis completed for all five selected Linux files. It emitted **0 lock-dependency edges, 0 interrupt-aware graph edges, and 0 cycle findings**. Therefore, this kernel scope does not contain enough positive findings to measure whether feasibility analysis reduces inconclusive cycle classifications.

There are no current findings to classify as candidate, potentially feasible, rejected, or inconclusive. The inconclusive-finding cause count is zero for each requested cause. This is not evidence that the driver is free of deadlocks: the analyzer found no cycles to assess, and the selected files are not a ground-truth bug set.

No source was modified to create a positive finding. The result is a scoped source analysis, not whole-kernel analysis or a claim of analyzer soundness.

## Pinned input and environment

| Item | Value |
|---|---|
| IRQGuard repository revision | `77e70a53cb6b34239e7bd1e90db975e15cf66fa4` |
| Working tree before evaluation | Clean |
| Linux source | v6.6.87, `814637ca257f4faf57a73fd4e38888cce88b5911` |
| Scope | `drivers/net/ethernet/intel/e1000e/{netdev,ethtool,ich8lan,phy,nvm}.c` |
| Configuration | x86_64 `x86_64_defconfig`, `CONFIG_E1000E=m` |
| Kbuild configuration SHA-256 | `488d466afc9efc70b31b8025cb664cb757b6079ba68e57246bb37d5f2d136cd1` |
| Compilation database SHA-256 | `c337536146b8c2dfa76fa25800cbbba9c56459e6a8ade0e01f6a6486aedc397d` |
| Analyzer SHA-256 | `d1bf6b6a4ad9dbec1a3062d06b54eb1a473f7a8756e30a36a3d8218eb9e1da4f` |
| Host | Ubuntu 24.04.4 LTS on WSL 2; host kernel `6.18.54.1-microsoft-standard-WSL2` |
| Clang / LLVM | Ubuntu Clang 20.1.2 (`0ubuntu1~24.04.3`) |
| GCC | 13.3.0 (`0ubuntu2~24.04.1`) |
| GNU Make / CMake | 4.3 / 3.28.3 |
| GNU linker / lld | GNU ld 2.42 / lld unavailable |
| `libelf-dev` | `0.190-1.1ubuntu0.1` |

The run used Clang through Kbuild with `ARCH=x86_64`, `LLVM=/usr/lib/llvm-20/bin/`, `LD=/usr/bin/ld`, and `HOSTLD=/usr/bin/ld`.

## Measurements

| Metric | Previous saved run | Fresh run |
|---|---:|---:|
| Files analyzed | 5/5 | 5/5 |
| Functions | 396 | 396 |
| Lock operations (acquire / release) | 12 (6 / 6) | 12 (6 / 6) |
| Lock dependencies | 0 | 0 |
| Interrupt-aware graph edges | 0 | 0 |
| Candidate cycles | 0 | 0 |
| Potentially feasible findings | 0 | 0 |
| Rejected findings | 0 | 0 |
| Inconclusive findings | 0 | 0 |
| Unknown-call root causes | 2,213 | 2,213 |
| Independent IRQ-state root causes | 0 | 0 |
| Linked IRQ-state secondary-effect records | 2,213 | 2,213 |
| Uncertainty events | 36,330 | 36,330 |
| Parser diagnostics | 2 | 2 |
| Summed analyzer time | 6.897 s | 6.551 s |
| Maximum per-process RSS | 236,344 KiB | 236,700 KiB |

The previous run is `evaluation/results/phase19.2/after/raw-measurements.json`. It used the same analyzer hash, kernel commit, and Kbuild configuration hash. This is a repeatability comparison, **not** an ablation comparing feasibility disabled versus enabled. The small time and memory differences are individual run measurements, not performance claims.

Per-file totals from the fresh run:

| File | Functions | Lock operations | Dependencies | Cycles | Uncertainty events | Diagnostics | Time |
|---|---:|---:|---:|---:|---:|---:|---:|
| `netdev.c` | 154 | 10 | 0 | 0 | 24,685 | 2 | 2.325 s |
| `ethtool.c` | 51 | 0 | 0 | 0 | 1,790 | 0 | 1.018 s |
| `ich8lan.c` | 98 | 2 | 0 | 0 | 6,396 | 0 | 1.320 s |
| `phy.c` | 76 | 0 | 0 | 0 | 2,887 | 0 | 1.019 s |
| `nvm.c` | 17 | 0 | 0 | 0 | 572 | 0 | 0.868 s |

The analyzer reports **six resolved IRQ registration sites** in `netdev.c` and two in `ethtool.c` (eight registration records total). These records resolve directly to handler definitions. They do not form findings in this run.

## Inconclusive findings and uncertainty causes

There were no cycle findings, so no inconclusive finding can be attributed to any uncertainty source. The table below reports both the finding impact (zero in every row) and the separate uncertainty evidence found in the source reports. Uncertainty records are not themselves findings.

| Cause | Inconclusive findings | Current uncertainty evidence |
|---|---:|---|
| Unknown lock identity | 0 | 89 unique records, 118 events |
| Unknown function summary / unresolved call | 0 | 2,213 unique call roots, 18,023 events; 1,991 missing-body records and 222 unresolved-target records |
| Unknown branch or path condition | 0 | No branch-condition finding; 2 CFG event-mapping records, 4 events |
| Unknown IRQ state | 0 | 2,213 secondary-effect records, 18,023 events; all 2,213 root IDs overlap unresolved-call roots, so 0 independent IRQ roots |
| Missing handler registration target | 0 | 0 handler-resolution records; 8 registration records were resolved directly |
| Handler teardown/lifecycle | 0 | 6 `free_irq` lifecycle records, 41 events; teardown timing is not modeled |
| Unsupported API | 0 | 121 unique records / 121 events; warning heuristic may include false positives |
| Other | 0 | 0 classified records |

The 2,213 IRQ-state records remain in the report and count as secondary effects; they are not silently discarded. Their root-cause IDs point to the 2,213 unresolved-call roots. The total unique root-cause count is 2,431 because those shared IRQ effects are not counted as additional independent roots.

The two parser/CFG diagnostics are in `netdev.c`, function `e1000_tx_csum`, at lines 5506 and 5510: call events could not be mapped into the CFG. They are not candidate cycles. Registration records and all uncertainty source locations are retained in the raw reports.

## Current classification inventory

All five translation units reported empty `lock_dependencies`, empty interrupt-graph edge arrays, and empty `interrupt_cycles` arrays. The category counts for candidate, potentially feasible, rejected, and inconclusive findings are therefore all zero. There is no finding path, lock sequence, IRQ-state trace, or finding-specific registration evidence to review. Eight direct `request_irq` registration records were resolved in the analyzed files, but none participate in a reported cycle.

The `mode_views` included in each report are projections over the same analyzer output, not separate analyzer executions. They do not establish what would have been reported with feasibility analysis disabled.

## Build validation

- Kernel preparation succeeded.
- Selected kernel objects compiled successfully.
- `objtool` was built and invoked once on the e1000e composite object with `--orc`, `--ibt`, `--retpoline`, `--module`, and `--link` checks.
- ORC sections were present in the composite object.
- A final `.ko` link was not attempted.
- Separate stack validation was not configured by this defconfig.
- Source analysis completed for all five requested files.

## Reproduction

From the repository root, with the pinned checkout and documented dependencies installed:

```sh
cmake --build build -j2
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/phase19.3/rerun-YYYYMMDD \
  --jobs 2 --timeout 120
python3 evaluation/summarize_uncertainties.py \
  evaluation/results/phase19.3/rerun-YYYYMMDD/reports \
  evaluation/results/phase19.3/rerun-YYYYMMDD/uncertainty-summary.json
python3 evaluation/analyze_uncertainty_impact.py \
  evaluation/results/phase19.3/rerun-YYYYMMDD/reports \
  evaluation/results/phase19.3/rerun-YYYYMMDD/uncertainty-impact.json
```

The completed run used `evaluation/results/phase19.3/rerun-20261104`. Curated copies of the raw measurements, Kbuild config, compilation database, build log, uncertainty summaries, impact ranking, and compressed per-file reports are in [`evidence/`](evidence/). Their checksums are listed in [`evidence/SHA256SUMS`](evidence/SHA256SUMS). Full generated build products remain in the local rerun directory and are not part of the curated evidence bundle.

## Conclusion

This run confirms that the corrected analyzer and configured Kbuild pipeline complete on the selected five-file Linux scope. It does **not** demonstrate that feasibility refinement improves real-kernel findings: this kernel scope does not contain enough positive findings to measure whether feasibility analysis reduces inconclusive cycle classifications. Controlled fixtures remain the evidence for feasibility behavior; a real historical positive case with independent source evidence is needed for a real-kernel effectiveness comparison.
