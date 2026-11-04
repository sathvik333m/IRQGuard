# Phase 19.1 — Lock operation consistency investigation

## Conclusion

The analyzer did not reclassify unlocks as acquisitions. The apparent `12 total / 10 acquisitions / 2 releases` result was a documentation error in the Phase 17 evaluation prose (`docs/phase17-evaluation.md`); it was also copied into the rewritten README during this phase. The Phase 17 machine-readable per-file summary and the source reports already classify the operations as **6 acquisitions and 6 releases**. The Phase 15 archive and a fresh run agree with that split.

The earliest divergence is therefore at **documentation/report prose generation (stage G)**. AST extraction, API classification, stored operations, JSON serialization, and the evaluation runner's acquisition/release counting do not show this discrepancy. The Phase 17 Markdown report displayed only the total of 12; its JSON summary contains the correct per-file split.

## Pipeline inspected

| Stage | Implementation | Evidence |
|---|---|---|
| Clang AST / macro-aware API recognition | `Extractor::VisitCallExpr` in `src/Analyzer.cpp` | Looks up the direct API, uses the expansion token to recover the public macro name, records spelling and expansion locations, then constructs one `ApiOperation`. |
| Operation kind assignment | `ApiRegistry` defaults in `src/ApiRegistry.cpp`; operation storage in `Extractor::VisitCallExpr` | Acquires use `lock_acquire` / `lock_acquire_irqsave`; releases use `lock_release` / `lock_release_irqrestore`. |
| Duplicate handling | `Extractor::VisitCallExpr` | Deduplicates nested macro AST calls by API name and expansion source site. |
| JSON serialization | `toJson` in `src/Output.cpp` | Serializes each `ApiOperation.kind`, API, locations, lock identity, and saved-state identity. |
| Kernel aggregation | `report_counts` and aggregate construction in `evaluation/run_kernel_eval.py` | Previously counted all `lock_*` operations as one total. Phase 19.1 adds acquire, release, and other-operation subtotals. |
| Phase 17 summary | `counts` and Markdown generation in `evaluation/run_phase17.py` | Its existing kind-specific count logic correctly distinguished ordinary and irqsave operations. The Markdown now displays the split too. |

The acquired API kinds are `lock_acquire` and `lock_acquire_irqsave`; release kinds are `lock_release` and `lock_release_irqrestore`. The analysis report counts each source operation once. `lock_operations` in kernel raw measurements is the total count, not an acquire-only count.

## Reproduction environment

- IRQGuard Git revision: `70e2a2aa0d1c8f897ab54473e4b4bd7ad3f216cf` (working tree had Phase 19.1 changes during the fresh run).
- Analyzer SHA-256: `d9763ff0da235e49e78ef7c736ac9ed880d127a6b5a6a45843ca84bfab3b0b35`.
- Kernel: Linux stable `v6.6.87`, commit `814637ca257f4faf57a73fd4e38888cce88b5911`.
- Source files: `netdev.c`, `ethtool.c`, `ich8lan.c`, `phy.c`, `nvm.c` in `drivers/net/ethernet/intel/e1000e`.
- Target: x86_64, `x86_64_defconfig`, `CONFIG_E1000E=m`; config SHA-256 `488d466afc9efc70b31b8025cb664cb757b6079ba68e57246bb37d5f2d136cd1`.
- Compilation database: 11 commands, generated from the pinned kernel's Kbuild records.
- Environment: Ubuntu 24.04 on WSL 2; Clang/LLVM 20.1.2; GNU Make 4.3; GCC 13.3.0; GNU ld 2.42; Python 3.12.3.
- Build validation: selected object compilation and objtool checks succeeded; ORC sections were present. Final module link was not attempted; separate stack validation was not configured.

Exact fresh command (output was written to the new timestamped `/tmp/irqguard-phase19.1-20261104T071027Z` directory):

```sh
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output /tmp/irqguard-phase19.1-20261104T071027Z \
  --jobs 2 --timeout 120
```

The recorded run analyzed 5/5 translation units and extracted 396 functions, 12 lock operations, 6 acquisitions, 6 releases, 0 other lock operations, 0 dependencies, 0 interrupt graph edges, 0 candidate cycles, 43,632 uncertainty events, and 2 diagnostics. Total per-file analysis time was 6.713 seconds; maximum per-process peak RSS was 244,344 KiB. Zero edges/cycles are not evidence of deadlock freedom.

## Operation inventory

| Translation unit | Function | Source line | API | Classification | Lock / saved state |
|---|---|---:|---|---|---|
| `netdev.c` | `e1000e_systim_to_hwtstamp` | 501 | `spin_lock_irqsave` | acquire, irqsave | `@param[0]->systim_lock` / local `flags` |
| `netdev.c` | `e1000e_systim_to_hwtstamp` | 503 | `spin_unlock_irqrestore` | release, irqrestore | `@param[0]->systim_lock` / same local `flags` |
| `netdev.c` | `e1000e_systim_reset` | 3935 | `spin_lock_irqsave` | acquire, irqsave | `@param[0]->systim_lock` / local `flags` |
| `netdev.c` | `e1000e_systim_reset` | 3938 | `spin_unlock_irqrestore` | release, irqrestore | `@param[0]->systim_lock` / same local `flags` |
| `netdev.c` | `e1000e_down` | 4299 | `spin_lock` | acquire | `@param[0]->stats64_lock` |
| `netdev.c` | `e1000e_down` | 4301 | `spin_unlock` | release | `@param[0]->stats64_lock` |
| `netdev.c` | `e1000_watchdog_task` | 5334 | `spin_lock` | acquire | unresolved adapter pointer → `stats64_lock` |
| `netdev.c` | `e1000_watchdog_task` | 5346 | `spin_unlock` | release | same unresolved adapter pointer expression |
| `netdev.c` | `e1000e_get_stats64` | 5974 | `spin_lock` | acquire | unresolved adapter pointer → `stats64_lock` |
| `netdev.c` | `e1000e_get_stats64` | 6005 | `spin_unlock` | release | same unresolved adapter pointer expression |
| `ich8lan.c` | `e1000_acquire_nvm_ich8lan` | 1850 | `mutex_lock` | acquire | `nvm_mutex` |
| `ich8lan.c` | `e1000_release_nvm_ich8lan` | 1863 | `mutex_unlock` | release | `nvm_mutex` |

The two `spin_lock_irqsave` sites expand at source lines 501 and 3935; Clang reports their spelling location in `include/linux/spinlock.h:244`. Their corresponding `spin_unlock_irqrestore` calls are source-level sites at lines 503 and 3938. The two pairs preserve matching symbolic lock and flags identities. The remaining eight calls are four ordinary acquire/release pairs.

## Snapshot comparison

| Snapshot | Total | Acquires | Releases | Acquire kinds | Release kinds |
|---|---:|---:|---:|---|---|
| Phase 15 archived JSON reports | 12 | 6 | 6 | 4 ordinary + 2 irqsave | 4 ordinary + 2 irqrestore |
| Phase 17 saved JSON reports | 12 | 6 | 6 | 4 ordinary + 2 irqsave | 4 ordinary + 2 irqrestore |
| Phase 19.1 fresh JSON reports | 12 | 6 | 6 | 4 ordinary + 2 irqsave | 4 ordinary + 2 irqrestore |

For each pairwise comparison, all 12 source sites were **same and consistently classified**. There were 0 missing, newly detected, duplicated, or reclassified sites. Historical Phase 13 comparison data also reports 6/6 before and after; its saved measurement JSON is aggregate evidence rather than a retained detailed operation inventory.

The Phase 17 saved JSON additionally reports `netdev.c` as 5 acquisitions / 5 releases and `ich8lan.c` as 1 / 1; all other selected files have zero operations. The mistaken prose counted the 10 operations in `netdev.c` but assigned the remaining aggregate as 10 acquisitions and 2 releases, instead of counting the kinds from the operation records. The actual evaluator helper did not contain that counting bug.

## Fixes and regression coverage

- `evaluation/run_kernel_eval.py` now records acquisition, release, and other lock-operation subtotals at file and aggregate level, so new raw measurement files expose the split explicitly.
- `evaluation/run_phase17.py` now includes acquire/release columns in its Linux table and prints both totals in its aggregate summary.
- `evaluation/lock_operation_inventory.py` produces a detailed JSON operation inventory with source and macro locations, identity, flags identity, and report hashes. It compares snapshots by source site and classifies missing, new, duplicate, and reclassified operations.
- `evaluation/test_lock_operation_accounting.py` tests acquire/release categories, conservation of the total, and each comparison classification. The Phase 17 integration test also asserts the per-file 5/5 and 1/1 split and generated aggregate text.
- Corrected the Phase 17 prose and README to say 6 acquisitions and 6 releases. Original raw reports and historical Phase 15/17 artifacts were not rewritten.

## Reproduction and artifacts

Rebuild and run all tests:

```sh
cmake -S . -B build -G Ninja \
  -DLLVM_DIR=/usr/lib/llvm-20/lib/cmake/llvm \
  -DClang_DIR=/usr/lib/llvm-20/lib/cmake/clang
cmake --build build -j2
ctest --test-dir build --output-on-failure
```

Regenerate the detailed inventory from the archived Phase 15 reports, saved Phase 17 reports, and a fresh run:

```sh
python3 evaluation/lock_operation_inventory.py \
  --phase15-archive evaluation/results/linux-v6.6.87/phase15-analyzer-reports.tar.gz \
  --phase17-reports /path/to/phase17/reports \
  --fresh-reports /path/to/fresh/reports \
  --output /path/to/new-inventory-directory
```

This investigation's `operation-inventory.json` and `operation-comparison.json` are the machine-readable detailed evidence. `fresh-reports.tar.gz`, `fresh-raw-measurements.json`, `fresh-compile-commands.json`, and `fresh-kbuild.config` preserve the current run's reports and build inputs. SHA-256 hashes are recorded in the JSON inventory or derive from the copied config/measurement files.

The Phase 17 controlled evaluator was run against the fresh report set: **8 assertions passed, 0 failed**. Full CTest result after the accounting and presentation changes: **19/19 passed**. These checks validate extraction/report consistency on the selected inputs; they are not a deadlock accuracy score.

## Remaining limits

The fresh Linux scope is five translation units, not a whole-driver call graph. Several lock identities in `netdev.c` remain unresolved. The zero dependency and cycle counts do not prove the absence of deadlocks. Kernel object, objtool, and ORC validation succeeded for the recorded bounded target, but the final module link and separate stack validation were not performed.
