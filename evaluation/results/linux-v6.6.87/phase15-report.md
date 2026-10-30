# Phase 15 — Kernel rerun and identity validation

## Environment and source

Linux stable `v6.6.87`, exact commit `814637ca257f4faf57a73fd4e38888cce88b5911`, was found at `/home/sathvik/linux-v6.6.87`. It was a clean Git checkout. To keep it persistent and colocated with IRQGuard, the checkout was moved (not copied or modified) to `third_party/linux-v6.6.87/`; the old external path is now absent. `.gitignore` excludes this upstream source tree from IRQGuard commits. The runner did not edit tracked kernel source files.

The run used Ubuntu 24.04 under WSL 2, Clang/LLVM 20.1.2, x86_64, Kbuild `x86_64_defconfig` plus `CONFIG_E1000E=m`, and generated an out-of-tree Kbuild directory. The config SHA-256 is `488d466afc9efc70b31b8025cb664cb757b6079ba68e57246bb37d5f2d136cd1`; generated compilation database contains 11 entries. The five analyzed files were `netdev.c`, `ethtool.c`, `ich8lan.c`, `phy.c`, and `nvm.c`.

The Phase 13 and Phase 15 runs have identical kernel commit, source file set, config hash, and Clang version. Both generated 11 compile commands; after normalizing checkout/build-output paths, the command argument sets match. The original Phase 9.0 compile database is not available, so this comparison does not extend to the older baseline.

## Fresh run results

The actual command was:

```sh
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87/phase15-rerun \
  --jobs 2
```

All five requested translation units analyzed; none failed or were skipped.

| Measure | Saved Phase 13 | Fresh Phase 15 | Change |
|---|---:|---:|---:|
| Functions | 396 | 396 | 0 |
| Lock operations | 12 | 12 | 0 |
| Lock dependencies | 0 | 0 | 0 |
| Interrupt graph edges | 0 | 0 | 0 |
| Candidate cycles | 0 | 0 | 0 |
| Raw uncertainty events | 43,514 | 43,632 | +118 |
| Unique uncertainty records | 4,833 | 4,922 | +89 |
| High-impact unique records | 2,582 | 2,671 | +89 |
| Lock-identity uncertainty events | 0 | 118 | +118 |
| Lock-identity unique records | 0 | 89 | +89 |
| Parser/analysis diagnostics | 2 | 2 | 0 |
| Analyzer elapsed time (sum across TUs) | 6.491 s | 7.744 s | +1.253 s |
| Peak RSS (maximum across separate processes) | 192,924 KiB | 237,700 KiB | +44,776 KiB |

The Phase 15 uncertainty records are grouped by category, stage, function, and source location in `phase15-uncertainty-summary.json.gz`; all five full reports are in `phase15-analyzer-reports.tar.gz`. Raw runner measurements are in `phase15-raw-measurements.json`, and the compact comparison is in `phase15-comparison.json`. These are actual tool outputs, not inferred accuracy metrics.

## Macro AST and irqsave evidence

A filtered Clang AST dump was run from the fresh `netdev.c` Kbuild command for `e1000e_systim_to_hwtstamp`. At the source invocation `netdev.c:501`, Clang represented the macro expansion as a call to `_raw_spin_lock_irqsave` in `include/linux/spinlock.h:244`, with a nested `spinlock_check` call in `include/linux/spinlock.h:381`. The flags assignment is represented in the expansion AST, while the unlock at `netdev.c:503` is a `spin_unlock_irqrestore` macro call. This is why the analyzer uses expansion-site API recognition and retains spelling locations; the `spinlock_check` wrapper itself is not modeled as an acquisition.

The fresh analyzer report extracts both pairs in `netdev.c`:

| Function | Acquire / release lines | Lock identity | Saved flags | Match |
|---|---|---|---|---|
| `e1000e_systim_to_hwtstamp` | 501 / 503 | `&@param[0]->e1000_adapter::systim_lock` (symbolic) | local `flags` at line 499 | yes |
| `e1000e_systim_reset` | 3935 / 3938 | `&@param[0]->e1000_adapter::systim_lock` (symbolic) | local `flags` at line 3910 | yes |

For both pairs, acquire and restore have the same lock identity and flags identity. The transfer saves the incoming abstract IRQ state and restore reinstates that saved value; it does not assume IRQs were initially enabled.

## Uncertainty investigation

The raw count increased by 118 events and 89 unique records. This is an intentional visibility change from Phase 15's conservative treatment of pointer aliases, not a reduction in uncertainty. All 118 events / 89 unique records are `lock_identity` at `lock_extraction` stage. They arise when a symbolic lock effect is propagated into caller contexts where a pointer-valued adapter expression cannot be proven equivalent. Representative paths include `e1000e_down` called from `e1000e_pm_freeze` and reset/resume paths; the adapter originates through kernel `netdev_priv`/device-data expressions. The supported alias resolver does not model those field/cast/pointer-return relationships, so it preserves explicit unresolved identity instead of merging by type or name.

These uncertainty records are high impact because they can affect whether a dependency edge exists. The saved and fresh reports associate zero uncertainty records with candidate cycles because both reports contain zero current cycles. That association does not establish that unresolved paths are harmless or that missed dependencies do not exist. The added lock-identity uncertainty is therefore reported as reduced identity certainty, not as a correctness improvement in the Linux result.

## Build-validation stages

- Source analysis: completed for all five files.
- Selected kernel C object compilation: succeeded.
- e1000e composite object: succeeded.
- Objtool build and deferred checks: succeeded; `--orc`, `--retpoline`, `--ibt`, module/link checks ran.
- ORC sections: present in the composite object.
- Final `.ko` link and full kernel build: not attempted.
- Separate stack validation: not configured by `x86_64_defconfig`; `SKIP_STACK_VALIDATION=1` is not supported by this kernel revision.

This is bounded subsystem validation, not complete Linux kernel validation. No lock cycles were reported in this selection, but this is not evidence that e1000e or Linux is deadlock-free. No precision or recall is calculated; no labeled ground-truth bug set was used.

## Reproduction

From the IRQGuard repository root:

```sh
cmake --build build -j2
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87/phase15-rerun \
  --jobs 2
ctest --test-dir build --output-on-failure
```

`third_party/linux-v6.6.87/` is intentionally ignored by Git because it is a large upstream checkout. The report archive and machine-readable measurements are tracked separately. The run output directory is disposable/ignored; rerunning regenerates its Kbuild directory, compile database, reports, timings, and logs. The full JSON per-file reports are also preserved in the compressed report archive next to this document.
