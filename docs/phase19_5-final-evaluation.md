# Final Evaluation and Evidence Baseline

## Objective and scope

This report records the behavior of the current IRQGuard implementation without changing analyzer semantics. It combines controlled fixtures, two independently documented historical Linux cases, and a bounded Linux v6.6.87 e1000e source evaluation. These evidence classes are reported separately. A reported graph cycle is a static candidate, not a confirmed deadlock.

## Analyzer and environment

- IRQGuard source revision: `9c1b6732410a5b6032237a80d278fc1f38669993`; the repository was clean at evaluation start. The baseline manifest records the analyzer binary SHA-256.
- Host: Ubuntu 24.04.4 LTS under WSL 2, x86_64; running host kernel `6.18.58.1-microsoft-standard-WSL2`.
- Clang/LLVM: 20.1.2; GCC: 13.3.0; GNU Make: 4.3; CMake: 3.28.3; Ninja: 1.11.1; Python: 3.12.3.
- Linux source: stable `v6.6.87`, commit `814637ca257f4faf57a73fd4e38888cce88b5911`.
- Kernel build configuration: `x86_64_defconfig`, `CONFIG_E1000E=m`, Kbuild `LLVM=/usr/lib/llvm-20/bin/`, GNU `ld` for host and target link steps; config SHA-256 is in `manifest.json`. Kbuild produced 11 compilation database entries.
- The pinned source checkout was not modified. Kbuild outputs and generated reports are stored under the baseline directory.

## Controlled tests

The existing versioned dataset has 8 assertions: 2 synthetic positive cases, 2 synthetic negative cases, and 4 edge cases. The current run passed all 8 assertions. The pass rate here is a regression-fixture result against expected behaviors, not a precision or recall estimate. Source reports, case assertions, uncertainty details, analysis durations and process peak RSS are preserved under `evaluation/baselines/phase19_5/controlled/`.

| Fixture | Group | Expected behavior | Result | Operations | Dependencies | IRQ-aware edges | Cycles |
|---|---|---|---:|---:|---:|---:|---:|
| `syn-positive-normal-cycle` | Positive | Report the expected regular lock-order candidate | Pass | 52 | 12 | 70 | 4 total classifications |
| `syn-positive-interrupt-cycle` | Positive | Report expected interrupt-aware candidate | Pass | 47 | 13 | 220 | 5 total classifications |
| `syn-negative-exclusive-branches` | Negative | Reject the incompatible branch combination | Pass | 52 | 12 | 70 | 4 total classifications |
| `syn-negative-release-before-next-acquire` | Negative | Do not produce the specified dependency | Pass | 47 | 13 | 220 | 5 total classifications |
| `edge-irqsave-restore-macro` | Edge | Extract irqsave API operation and macro provenance | Pass | 36 | 5 | 0 | 0 |
| `edge-saved-irqstate-pair` | Edge | Pair lock identity and saved-state identity | Pass | 52 | 12 | 70 | 4 total classifications |
| `edge-locking-wrapper` | Edge | Propagate irqsave operation through wrapper | Pass | 47 | 13 | 220 | 5 total classifications |
| `edge-interprocedural-symbolic-lock` | Edge | Preserve argument-dependent lock effects | Pass | 23 | 4 | 0 | 1 |

The `IRQ-aware edges` column counts graph edges whose kind is `interrupt_preemption`; rejected preemption edges are excluded. “Cycles” is the total number of cycle records in that source report; it includes rejected and inconclusive entries, so it is not a count of confirmed deadlocks. Exact category counts and uncertainties are in `controlled/summary.json` and the per-source JSON reports. The fixture set is intentionally small and partly synthetic; no statistical accuracy metric is derived from it.

The positive fixture assertion rate was **2/2**, the negative fixture assertion rate was **2/2**, and the edge-case assertion rate was **4/4**. The complete CTest suite passed **23/23** tests. The web suite passed **42/42** tests; standard and static TypeScript/Vite builds succeeded. Recharts emitted its existing zero-sized test-container warnings; the builds also reported a large JavaScript chunk warning. Logs are retained in this directory. The kernel page now loads this frozen run and links to its JSON summary endpoint, with a bundled summary for static builds. An end-to-end HTTP check could not run here because the environment rejects local port binding with `listen EPERM`; backend syntax and frontend contract tests passed.

## Historical Linux cases

These cases use independent upstream evidence and compare pinned affected/fixed revisions. They are not synthetic fixtures.

| Case | Affected revision | Fix revision | IRQGuard result | Evidence and limitation |
|---|---|---|---|---|
| MIPS GIC recursive `gic_lock` acquisition | `03c4d26933d54556a89379db5923ae9e474569e8` | `1bae25dcc6beb8b874f23601d2efa142ac4f9f36` | **Partial match; inconclusive cycle** | Affected source yields one `gic_lock` dependency/cycle across `gic_set_affinity()` and `gic_set_type()`. Fixed source yields no cycle, but `guard(raw_spinlock_irqsave)` is not extracted, so the fixed-side absence does not demonstrate complete coverage. |
| 8250 serial IRQ/port lock inversion | `547bbf7d214fff2d29bc885ea7efea0fbc127791` | `730037c3ee57f892e6df019bc88d417a5944737c` | **Miss** | The run covers only `8250_port.c`, reports `disable_irq_nosync()` as unresolved, and extracts no dependencies/cycles on either side. IRQ descriptor and console paths are outside this translation unit. |

For MIPS, affected/fixed runs recorded respectively 8/6 lock operations, 1/0 dependencies, and 1/0 cycles; cycle classification on the affected revision is `inconclusive_analysis`. The upstream fixing commit is [1bae25dcc6beb8b874f23601d2efa142ac4f9f36](https://git.kernel.org/pub/scm/linux/kernel/git/tip/tip.git/commit/?id=1bae25dcc6beb8b874f23601d2efa142ac4f9f36), with its [mailing-list discussion](https://lkml.iu.edu/2610.1/17783.html). For 8250, both revisions recorded 39 lock operations, 0 dependencies and 0 cycles. The upstream fix is [730037c3ee57f892e6df019bc88d417a5944737c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=730037c3ee57f892e6df019bc88d417a5944737c), with the [patch discussion](https://lore.kernel.org/lkml/20200817022646.1484638-1-sergey.senozhatsky@gmail.com/). Both historical comparison scripts passed their regression assertions; this validates the recorded comparison logic, not successful detection of both bugs. Upstream evidence and per-revision reports are included under `historical/` and `evidence/`.

## Pinned real-kernel exploratory run

The selected files are `netdev.c`, `ethtool.c`, `ich8lan.c`, `phy.c`, and `nvm.c` from `drivers/net/ethernet/intel/e1000e`. Kbuild prepared headers, compiled the selected objects, generated a compilation database, and ran objtool checks on the composite object. All 5 translation units analyzed; none were skipped or failed.

| Metric | Measured result |
|---|---:|
| Functions | 396 |
| Calls | 3,571 (sum of extracted call records) |
| Lock operations | 12: 6 acquisitions, 6 releases |
| Dependencies | 0 |
| Interrupt registrations | 8 resolved `request_irq` records |
| Interrupt-aware graph edges | 0 |
| Candidate cycles | 0 |
| Inconclusive cycle findings | 0 |
| Uncertainty events | 36,330 |
| Unique uncertainty records | 4,644 |
| Unique root-cause IDs | 2,431 |
| Repeated propagation events | 31,686 |
| Parser/CFG diagnostics | 2 |
| Sum of five analyzer process times | 8.116 s |
| Maximum per-process peak RSS | 236,264 KiB |

The uncertainty event categories sum to 36,330: unresolved calls 18,023; interrupt-state effects 18,023; unsupported APIs 121; lock identity 118; handler lifecycle 41; control flow 4. Categories can represent linked effects from the same unresolved call and are not independent causes. The run extracted 121 unsupported API records. The two diagnostics are call-to-CFG mapping issues in `e1000_tx_csum`. No uncertainty is reported as proven non-impacting. Full per-file category, stage, function and provenance data lives in the JSON reports.

The run found no cycles. Therefore, this scope does not provide positive real-kernel examples with which to measure whether feasibility refinement reduces inconclusive classifications. The zero-cycle result does not imply the source is deadlock-free.

### Build-validation coverage

Source analysis completed; selected kernel object compilation succeeded; objtool built and its deferred composite-object checks succeeded; ORC sections were generated. The final module was not linked, the full kernel was not built, and separate stack validation was not configured by the selected defconfig. The run used GNU ld; `lld` was unavailable, but it was not required for the recorded target. `libelf-dev` was installed. These results must not be described as full kernel build validation.

## Phase 15/17 lock-operation discrepancy

The apparent `12 total / 10 acquisitions / 2 releases` count was not reproduced as an extraction defect. Phase 15 and Phase 17 saved raw inventories both contain 12 operations: 6 acquisitions and 6 releases (including irqsave/irqrestore pairs). Phase 19.1 traced the `10/2` statement to incorrect report prose. The fresh Phase 19.5 run again records 6/6. The uncertainty count differs from older snapshots because the analyzer/evaluation revisions differ; the lock-operation inventory does not.

## Metrics and interpretation

- Controlled fixture assertion pass rate: 8/8 (100% on these declared assertions only).
- Historical cases: 0 fully detected, 1 partial match (the affected MIPS cycle itself is `inconclusive_analysis`), 1 miss, and no additional standalone inconclusive case. IRQGuard independently confirmed 0 deadlocks.
- Real-kernel coverage: 5/5 selected translation units; this is not whole-driver or whole-kernel coverage.
- Precision, recall, F1 and false-positive rate are **not calculated**. The controlled set is not an independent representative ground truth, and the two historical cases are too few and include a partial match and a miss.
- The historical classifications derive from upstream reports/patches plus source and analyzer evidence. Static findings alone do not establish a runtime deadlock.

## Limitations and missed cases

The 8250 miss is caused in part by unresolved `disable_irq_nosync()` semantics and missing genirq/console translation units. The MIPS result is weakened by uncertain summary evidence and missing extraction of the fixed-side guard macro. The e1000e sample has no dependency edges and therefore cannot test cycle recall or feasibility improvements. General aliasing, cross-translation-unit call propagation, callback lifecycle, many kernel wrappers/APIs, and arbitrary path predicates remain unsupported or conservative. Unresolved operations and uncertainty are retained in the raw JSON; no warnings were suppressed for this baseline.

## Reproduction

From the repository root, use a clean build and fresh output directories. The full exact command list, environment, revision pins, config hash and artifact hashes are in `evaluation/baselines/phase19_5/manifest.json`.

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure

python3 evaluation/run_phase17.py \
  --analyzer build/deadlock-analyzer \
  --dataset evaluation/dataset-v1.json \
  --output /tmp/irqguard-p19-5-controlled \
  --kernel third_party/linux-v6.6.87 \
  --kernel-raw /tmp/irqguard-p19-5-kernel/raw-measurements.json \
  --kernel-reports-dir /tmp/irqguard-p19-5-kernel/reports

python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output /tmp/irqguard-p19-5-kernel \
  --jobs 2 --timeout 120

python3 evaluation/run_historical_case.py \
  --analyzer build/deadlock-analyzer --source-root historical-case \
  --output /tmp/irqguard-p19-5-mips --llvm /usr/lib/llvm-20/bin

python3 evaluation/run_serial8250_case.py \
  --analyzer build/deadlock-analyzer --llvm /usr/lib/llvm-20/bin \
  --output /tmp/irqguard-p19-5-8250
```

The historical runners require the documented pinned worktrees. Keep new outputs separate; do not overwrite the frozen evidence. Then pass the completed output directory to the existing summarizer or use the JSON reports directly. `python3 evaluation/freeze_phase19_5.py` consolidates the already completed baseline inputs and is intended to run from the repository root.

## Final assessment and next-step readiness

IRQGuard is reproducible on the controlled suite and can identify one upstream-described recursive lock pattern partially. It misses the selected 8250 inversion, and its current real e1000e scope produces no dependencies or cycles with substantial uncertainty. It is not ready to make kernel-wide deadlock claims. Phase 20 may proceed as further scoped research only after using this baseline as the comparison point; any new capability should retain the same affected/fixed and negative regression evidence.
