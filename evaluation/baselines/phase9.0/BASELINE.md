# Phase 9.0 baseline reproduction

Date: 2026-10-28 (UTC)

## Summary

The repository build and full CTest suite reproduced. The pinned Linux source
was not available for a fresh analysis: `/tmp/linux-v6.6.87` had been removed,
and cloning the pinned tag failed because this environment could not resolve
`git.kernel.org`. The existing kernel report and raw measurement artifact were
preserved before any code changes. Their recorded analyzer SHA-256 matches the
currently built executable, so the saved data is attributable to this analyzer
binary; it is still a saved run, not a fresh Phase 9.0 kernel rerun.

No source or configuration changes were made during baseline inspection.
Baseline evidence is stored beside this report:

- `kernel-v6.6.87-raw-measurements.json`: pinned revision, tool versions,
  commands, configuration hash, per-file counts, timing and RSS.
- `kernel-v6.6.87-report.md`: the saved evaluation interpretation.
- `kernel-v6.6.87-build.log`: saved Kbuild command log.
- `kernel-v6.6.87-raw-reports.tar.gz`: per-translation-unit JSON, stderr and
  `/usr/bin/time` reports.

## Repository and toolchain

- Repository revision: `23f602b2f725ea385cff4d3715e8e1906a52dfee`
  (`fixed_errors`, 2026-10-23).
- The working tree was clean before this baseline report and evidence snapshot
  were created.
- CMake: 3.28.3; CMake C++ compiler: `/usr/bin/c++`; GCC/G++: 13.3.0.
- Clang/Clang++: `/usr/lib/llvm-20/bin`, version 20.1.2.
- LLVM: 20.1.2; analyzer links against Clang/LLVM 20.
- Pinned kernel in the saved evaluation: Linux stable `v6.6.87`, commit
  `814637ca257f4faf57a73fd4e38888cce88b5911`.
- Saved analyzer SHA-256 and current `build/deadlock-analyzer` SHA-256 both:
  `dd9221162839ada581675aa4edc5c06a3f7b6e1989d840d6680306e862f7d34b`.

## Reproduction commands and results

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure
```

Build result: success (`ninja: no work to do`). Test result: **8/8 passed** in
2.38 seconds.

The saved report's prescribed kernel evaluation command is:

```sh
python3 evaluation/run_kernel_eval.py \
  --kernel /tmp/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87 --jobs 2
```

It could not be rerun because the source checkout was absent. The source
retrieval attempt was:

```sh
git clone --depth 1 --branch v6.6.87 \
  https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git \
  /tmp/linux-v6.6.87-phase9
```

It failed with exit code 128: `Could not resolve host: git.kernel.org`. No new
kernel metrics are claimed for this phase.

## Saved kernel evaluation facts

The saved analysis contains five successful translation-unit reports:

| Measure | Saved value |
| --- | ---: |
| Functions | 396 |
| Lock API operations | 12 |
| Lock dependencies | 6 |
| Interrupt graph edges / nodes | 6 / 9 |
| Cycle reports | 3, all `inconclusive_analysis` |
| Uncertainty entries | 43,705 |
| CFG mapping diagnostics | 2 |
| Analyzer elapsed time, summed | 6.644 s |
| Peak RSS, maximum across runs | 192,312 KiB |
| Files skipped or failed | 0 / 5 |

`netdev.c` contains the two macro-expanded acquisitions at lines 501 and 3935
as `_raw_spin_lock_irqsave` events. The corresponding `spin_unlock_irqrestore`
events are at lines 503 and 3938. The acquisitions are no longer absent, but
the extracted expression `spinlock_check(&adapter->systim_lock)` is unresolved
and the return-flags helper does not expose the original flags lvalue. The
analyzer therefore does not establish matching lock identity or precise IRQ
state for those operations.

The three cycle reports each consist of a one-edge regular self-cycle over an
`unknown-context` lock identity. They are marked inconclusive and must not be
treated as real deadlocks.

The diagnostics are not Clang syntax/parser errors. They are CFG event mapping
diagnostics in `e1000_tx_csum` for calls at `netdev.c:5506` and `:5510`. The
saved stderr files are empty; all five translation units were reported as
analyzed.

## Uncertainty count interpretation

The `uncertainties` field contains 43,705 serialized message strings. The
saved reports contain no exact duplicate strings, so this is both the raw list
length and the number of unique exact strings. It is **not** a count of
independent root causes or source call sites: caller summaries prefix and
propagate callee messages, and IRQ summaries emit a second projection of
uncertainty.

The following mutually exclusive buckets were derived from each message's
text for this baseline inspection:

| Message class | Count |
| --- | ---: |
| External or unavailable function body | 20,683 |
| IRQ-state summary uncertainty | 21,777 |
| Unresolved indirect call | 1,059 |
| Possibly unsupported lock/IRQ API | 154 |
| Unresolved lock identity | 30 |
| CFG mapping | 2 |
| **Total** | **43,705** |

These are string-category counts, not a deduplicated causal analysis. In
particular, an external call may contribute both an interprocedural missing
body message and an IRQ-state unknown-effect message. Lowering this count by
discarding messages would lose evidence and is not a proposed fix.

## Build-validation status

The saved Kbuild log records successful selected object compilation with Clang
20 and five generated compilation database entries. It also records explicit
overrides `CONFIG_OBJTOOL=` and `SKIP_STACK_VALIDATION=1`. Thus the selected
object compiler steps ran, but objtool and stack-validation coverage did not.
The exact commands and limitation are in the saved raw measurements and log.

This host currently has no `ld.lld-20` executable and no `libelf-dev` package or
`/usr/include/gelf.h`; these absence checks confirm the recorded limitation.
The previous build output contains the five `.o` files, but the original kernel
source tree is missing, so this baseline does not independently verify those
object files or validation stages now.

## Implementation map and issue status

| Reported observation | Baseline finding | Implementation locations |
| --- | --- | --- |
| `spin_lock_irqsave` acquisition missing | The reported absence is not reproduced in the saved run: two raw helper acquisition events are present. Their lock expressions are unresolved and flags state is unknown, so semantic extraction remains incomplete. | `Extractor::VisitCallExpr` and `canonicalExpression` in `src/Analyzer.cpp`; defaults in `ApiRegistry::ApiRegistry` in `src/ApiRegistry.cpp`. |
| About 43,705 uncertainties | Confirmed in saved report. All exact strings are unique, but many reflect repeated interprocedural and IRQ-state propagation rather than independent causes. | `summarizeFunction` and `analyzeInterprocedural` in `src/Interprocedural.cpp`; `summarizeFunction` and `analyzeInterrupts` in `src/InterruptAnalysis.cpp`. |
| Two parser diagnostics | Two diagnostics are present, but they are CFG-to-call mapping failures, not Clang parse errors. | `buildCFG` in `src/Analyzer.cpp`; diagnostics recorded at `netdev.c:5506` and `:5510`. |
| Three candidate cycles | Confirmed as three outputs, all inconclusive self-cycles on unresolved identities. No independent source validation establishes a deadlock. | `analyzeInterrupts` graph construction and `detectCycles` in `src/InterruptAnalysis.cpp`. |
| Object-tool/stack validation skipped | Confirmed from recorded Kbuild arguments; no fresh kernel build could be performed. | `evaluation/run_kernel_eval.py` Kbuild setup and selected-object commands. |

## Minimal fix plan

1. Preserve public macro arguments through Clang preprocessor callbacks or an
   equivalent source-aware mechanism. Bind `spin_lock_irqsave`'s lock and
   flags arguments to the helper call; keep them unresolved when the mapping
   is ambiguous. Test nested and aliased macros against real Kbuild-preprocessed
   source.
2. Add structured uncertainty cause/site identifiers and report both raw
   emitted messages and grouped cause counts. Keep all underlying evidence;
   do not suppress uncertain operations to reduce the headline count.
3. Investigate the two CFG mapping misses at `e1000_tx_csum:5506` and `:5510`.
   Add a regression fixture for the relevant AST/CFG shape and ensure missing
   mappings remain explicit.
4. Review the three self-cycles with unresolved lock identities. Require
   identity evidence before classifying same-lock cycles as candidates; keep
   ambiguous cases inconclusive. Independently inspect the surrounding kernel
   call paths before assigning any bug status.
5. When the pinned source is available again, provision matching `lld` and
   `libelf` development packages, use a separate evaluation output directory,
   run selected Kbuild objects without `CONFIG_OBJTOOL=` or
   `SKIP_STACK_VALIDATION=1`, and record which objtool/stack-validation stages
   actually execute. Retain the earlier skipped-validation evidence unchanged.

No fixes are started in this Phase 9.0 baseline step.
