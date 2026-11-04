# Phase 19.2 — High-impact uncertainty root causes

## Outcome

The fresh Phase 19.1 pipeline reproduced the earlier uncertainty volume. Most raw events were repeated summary propagation, and each unresolved call had a matching IRQ-state uncertainty from the separate IRQ summary pass. I added narrow no-lock/no-IRQ effects for five compiler intrinsics and two Linux helpers whose behavior was verified in the pinned Linux v6.6.87 source. Unknown functions and callbacks remain unknown.

The change reduced uncertainty records because supported effects are now modeled, not because warnings were hidden or deduplicated. It did not change extracted lock operations or produce any new lock dependency edge. The selected kernel run still has no candidate cycle, so this evaluation cannot show that the change improved a reported finding.

## Baseline and environment

- IRQGuard baseline Git revision: `8c1edb182f3b4d923788a01f10d48214f1a687cd` (Phase 19.1); the working tree was clean before this phase.
- Kernel: Linux stable `v6.6.87`, commit `814637ca257f4faf57a73fd4e38888cce88b5911`.
- Scope: `netdev.c`, `ethtool.c`, `ich8lan.c`, `phy.c`, and `nvm.c` under `drivers/net/ethernet/intel/e1000e`.
- Configuration: x86_64 `x86_64_defconfig`, `CONFIG_E1000E=m`, 11 Kbuild compilation commands.
- Environment: Ubuntu 24.04 on WSL 2; Clang/LLVM 20.1.2, GCC 13.3.0, GNU Make 4.3, CMake 3.28.3, Python 3.12.3.
- Both runs parsed 5/5 requested files, with 396 functions and two parser diagnostics. The kernel source, configuration, validation stages, and tool versions are recorded in each `raw-measurements.json`.
- Baseline analyzer SHA-256: `d9763ff0da235e49e78ef7c736ac9ed880d127a6b5a6a45843ca84bfab3b0b35`.
- After analyzer SHA-256: `d1bf6b6a4ad9dbec1a3062d06b54eb1a473f7a8756e30a36a3d8218eb9e1da4f`.

The baseline command was:

```sh
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output /tmp/irqguard-phase19.2-baseline-20261104T072700Z \
  --jobs 2 --timeout 120
```

The final after command was:

```sh
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output /tmp/irqguard-phase19.2-final-20261104T074714Z \
  --jobs 2 --timeout 120
```

Raw reports were passed to `evaluation/summarize_uncertainties.py` and `evaluation/analyze_uncertainty_impact.py`. The baseline and after artifacts under `evaluation/results/phase19.2/` retain the raw measurement JSON, compilation database, kernel config, build log, compressed full reports, compressed uncertainty summaries, impact rankings, and SHA-256 sums.

### Earlier 43,705 count

The earlier 43,705 figure is reproducible by recounting the existing `evaluation/results/linux-v6.6.87/reports/*.json` uncertainty arrays. It is from an older analyzer binary (`dd9221162839ada581675aa4edc5c06a3f7b6e1989d840d6680306e862f7d34b`), so it is not the correct before count for this change. The Phase 19.1 archive and the fresh Phase 19.2 baseline both produce 43,632 with the same Phase 19.1 analyzer hash (`d9763ff0…`).

The old 43,705 report categories were: 21,742 unresolved-call events, 21,734 IRQ-state events, 30 lock-identity events, and 154 unsupported-API warnings (the other categories were unchanged). The fresh Phase 19.2 baseline has 21,674, 21,674, 118, and 121 respectively. These deltas net to −73. The older result includes more unsupported-API heuristic warnings and unresolved-call/IRQ records, while the newer interprocedural analysis exposes more lock-identity propagation records. This is a model/reporting revision difference, not a 73-event reduction attributable to Phase 19.2. The full Phase 19.2 before/after comparison therefore uses the preserved 43,632 Phase 19.1 snapshot as its baseline.

## Counting rules

- **Raw event:** one string in one translation unit report's `uncertainties` array. Events are preserved in the compressed `source-reports.tar.gz` archives.
- **Unique record:** one category and terminal cause at a source location in a translation unit. Propagation prefixes are stripped for this key; different categories and locations remain separate.
- **Unique root cause:** distinct `(translation unit, root_cause_id)`. An IRQ-state record caused by an unresolved call retains its own record ID but points to the unresolved-call record's `root_cause_id` and `causal_parent_ids`.
- **Propagated event:** a message carrying an interprocedural `via call` or IRQ-summary propagation prefix. It is counted as propagation, not treated as a new direct source event.
- **Impact ranking:** `analyze_uncertainty_impact.py` sorts by finding/edge overlap, lock-held context, IRQ effect, number of affected functions, and event frequency. This is a triage order, not a probability or calibrated risk score.

These rules keep two views distinct: category records preserve the evidence from both analysis passes, while `unique_root_cause_count` avoids counting a paired IRQ consequence as a separate underlying call problem. The event counts are not reduced by this linkage.

## Before and after

| Measure | Phase 19.1 baseline | Phase 19.2 after | Change |
|---|---:|---:|---:|
| Raw uncertainty events | 43,632 | 36,330 | −7,302 |
| Unique category records | 4,922 | 4,644 | −278 |
| Unique root causes | 2,570 | 2,431 | −139 |
| Propagated events | 38,710 | 31,686 | −7,024 |
| High-impact unique records | 2,671 | 2,530 | −141 |
| Unresolved-call events | 21,674 | 18,023 | −3,651 |
| IRQ-state events | 21,674 | 18,023 | −3,651 |
| Lock-identity events | 118 | 118 | 0 |
| Paired IRQ secondary-effect records | 2,352 | 2,213 | −139 |
| Lock operations (6 acquire / 6 release) | 12 | 12 | 0 |
| Lock dependencies / interrupt edges / cycles | 0 / 0 / 0 | 0 / 0 / 0 | 0 |
| Candidate-affecting uncertainty records | 0 | 0 | 0 |
| Parser diagnostics | 2 | 2 | 0 |
| Summed per-file analysis time | 6.918 s | 6.897 s | −0.021 s |
| Maximum per-process peak RSS | 244,316 KiB | 236,344 KiB | −7,972 KiB |

The time and memory differences are measurements from two individual runs, not a performance claim. The analysis still reports no candidate cycles for this five-file scope; that is not evidence that the driver is deadlock-free.

The event reduction is exactly accounted for by call models: 3,621 unresolved-call events and 3,621 paired IRQ-state events. These came from five compiler intrinsics plus two Linux helpers. The 139 fewer root causes are one category record for each direct call issue and one linked IRQ effect record per site; propagations from those records account for the remaining event decrease. Lock-identity, handler-lifecycle, control-flow, and unsupported-API counts did not change.

## Root-cause investigation

### Unknown calls and propagation

Before the fix, the largest unresolved root was `__builtin_constant_p` at `netdev.c:128`: 1,937 records/events in the report set, including 1,936 propagated occurrences and one direct source event. It appeared along paths reaching 80 functions. `__builtin_ffsll` at `phy.c:254` contributed 152 events. The impact report also showed repeated unresolved `__builtin_bswap16`, `__builtin_expect`, and `__builtin_prefetch` compiler intrinsics.

Those exact compiler intrinsics have no lock or local IRQ effects. The Phase 19.2 model now recognizes only these exact names:

- `__builtin_constant_p`
- `__builtin_ffsll`
- `__builtin_bswap16`
- `__builtin_expect`
- `__builtin_prefetch`

It also recognizes two exact Linux helpers reviewed against the pinned source:

- `ktime_to_ns`: `include/linux/ktime.h` returns the `ktime_t` value directly.
- `timecounter_cyc2time`: `kernel/time/timecounter.c` reads counter fields and performs arithmetic through `cyclecounter_cyc2ns`; it does not acquire a lock, change local IRQ state, or invoke the cyclecounter read callback.

`__builtin_unreachable` deliberately remains unresolved. It affects control-flow reachability, which this no-lock/no-IRQ effect summary does not model. A test ensures the allowlist is exact and ordinary external functions remain uncertain.

After the fix the largest remaining roots include `__er32` (1,937 events across 80 functions), `__const_udelay` (1,937 across 80), and `writel` (1,904 across 79). Their uncertainty propagates to paired IRQ-state records. `writel`, `readw`, and `writew` are not treated as safe merely because they are common accessors; their target bodies are absent from this source scope and remain unresolved.

### IRQ-state uncertainty as a secondary effect

The interprocedural pass emits an unresolved-call record when a target body is missing. The IRQ pass independently sets IRQ state and saved flags to `unknown` for the same unmodeled call and emits `unmodeled call may alter IRQ state`. The baseline contained 2,352 unique records in each category and 2,352 exact causal links. After the intrinsic/helper summaries, it contains 2,213 records and links in each set.

This supports the conclusion that, in these reports, IRQ-state uncertainty was a secondary consequence of unresolved calls rather than a separate set of 2,352 independent root problems. The records are still both present, with their source locations and propagation examples; JSON now exposes `root_cause_id`, `causal_parent_ids`, `causal_relation`, and `propagation_examples`.

### Lock-held calls and actual impact

Baseline ranking found 106 raw unresolved-call events at six call sites labeled “while holding a lock.” They are in `netdev.c` around the `systim_lock` critical sections:

- `spinlock_check` at lines 501 and 3935.
- `timecounter_cyc2time` at line 502.
- `timecounter_init` at line 3936.
- `ktime_get_real` and `ktime_to_ns` at line 3937.

The source shows `spinlock_check` is part of the `spin_lock_irqsave` macro expansion at the acquisition source line. Its “while holding” label is therefore not reliable evidence that the helper runs after acquisition; this is an event-ordering/macro-location ambiguity and remains a review item. In the pinned non-RT configuration its inline body returns `&lock->rlock`, but the analyzer does not bind that helper summary to the kernel configuration, so it remains unresolved.

`timecounter_init` calls the cyclecounter's `read` callback, and `ktime_get_real` reaches out-of-scope timekeeping implementation. Both remain unresolved because an indirect callback or unavailable implementation may have relevant effects. The corresponding source lines are inside the lock critical section, so the uncertainty is genuinely relevant to possible IRQ-state reasoning. After modeling `ktime_to_ns` and `timecounter_cyc2time`, 76 raw unresolved events remain labeled lock-held: 30 `spinlock_check` records with the macro-order caveat and 46 events for the two calls whose effects remain unresolved. None overlap a current graph edge or candidate because this selected analysis generated zero dependencies/cycles.

## Changes and regression coverage

- `include/deadlock/KnownEffects.h` contains an exact allowlist; unknown functions, device accessors, callbacks, and `__builtin_unreachable` remain visible.
- `src/Interprocedural.cpp` and `src/InterruptAnalysis.cpp` use the same no-lock/no-IRQ summary so an approved effect does not produce mismatched lock and IRQ results.
- `src/Output.cpp` now makes root-cause and causal-parent IDs explicit and includes bounded propagation examples and unique-root/secondary-effect counts.
- `evaluation/summarize_uncertainties.py` retains raw-event counts, groups causes, links paired effects, and distinguishes unique roots from unique category records.
- `evaluation/analyze_uncertainty_impact.py` reproducibly ranks call roots by call frequency, function reach, lock-held records, IRQ consequences, and overlap with current edges/findings.
- New fixture `tests/fixtures/known_compiler_builtins.c` checks exact safe models, a still-unknown external call, and a deliberately unmodeled control-flow intrinsic. `tests/test_known_compiler_builtins.py` checks the JSON and impact reports. `tests/test_uncertainty_reporting.py` protects causal IDs and propagation accounting.

Commands run:

```sh
cmake --build build -j2
python3 tests/test_uncertainty_reporting.py build/deadlock-analyzer tests/fixtures/uncertainty_propagation.c
python3 tests/test_known_compiler_builtins.py build/deadlock-analyzer tests/fixtures/known_compiler_builtins.c
ctest --test-dir build --output-on-failure
```

Result: **20/20 CTest tests passed**, and both targeted Python tests passed.

## Remaining limitations

- The two helper summaries and five compiler intrinsic summaries are narrow exact-name models, not general function summarization or proof that every kernel helper is safe.
- The analyzer does not currently ingest kernel configuration as an effect-summary constraint; `spinlock_check` remains unresolved rather than assuming its non-RT implementation everywhere.
- The selected scope has no graph edges or cycles, so there is no empirical evidence here that the change changes cycle feasibility or classification.
- The raw report count is still 36,330. Most remaining events are unresolved helper/callback summaries and repeated propagation. They remain visible.
- The 2,213 paired IRQ records describe the current implementation's conservative transfer behavior, not proof that each unknown call really changes IRQ state.
- The kernel build evidence remains the bounded Phase 12 validation recorded in the raw measurement. The after run did not link the final module or configure separate stack validation.
- No precision/recall metric is reported; the selected kernel sample has no independently labeled deadlock ground truth.

To verify archived artifacts, run `sha256sum -c SHA256SUMS` from either `evaluation/results/phase19.2/baseline/` or `evaluation/results/phase19.2/after/`. The summary and impact files are gzip-compressed JSON; source reports are a gzip-compressed tar archive.
