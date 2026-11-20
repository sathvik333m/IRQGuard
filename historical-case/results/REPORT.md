# Historical Linux locking bug evaluation

This evaluation contains two independently documented historical positives: one partial match and one miss. Both have adjacent affected/fixed revisions. The historical set currently has no independently verified safe/negative Linux case; controlled negative fixtures are recorded separately and are not counted as Linux ground truth. No accuracy metric is reported.

## Case and independent evidence

The upstream tip fix `1bae25dcc6beb8b874f23601d2efa142ac4f9f36` documents a recursive acquisition of the global `gic_lock` in `gic_set_affinity()`. On a cross-cluster affinity change, `gic_set_affinity()` already holds `gic_lock` and calls `gic_set_type()`, which takes the same raw spinlock with `raw_spin_lock_irqsave()`. The fix factors the body into `gic_set_type_locked()` and calls that helper from the already-locked path. The patch identifies the bug-introducing change as `322a9063876890895cb8308cc6f59de312e8aad5`.

The primary evidence is the [upstream fix commit](https://git.kernel.org/pub/scm/linux/kernel/git/tip/tip.git/commit/?id=1bae25dcc6beb8b874f23601d2efa142ac4f9f36) and its [kernel mailing-list patch discussion](https://lkml.iu.edu/2610.1/17783.html). Those sources explicitly describe the recursive lock and deadlock; this label does not come from IRQGuard.

The evaluated affected source is the fix commit's immediate parent, `03c4d26933d54556a89379db5923ae9e474569e8`. The fixed source is the single commit above. This adjacent pair isolates the fix; the original 2024 bug-introducing commit remains recorded as provenance and is not used as the paired comparison. Both checkouts are detached Git worktrees and were not edited.

## Reproduction environment

- Ubuntu 24.04 / WSL 2 host environment.
- Linux source: MIPS GIC driver, `drivers/irqchip/irq-mips-gic.c` only.
- Configuration: MIPS `malta_defconfig`, `CONFIG_SMP=y`, `CONFIG_MIPS_GIC=y`.
- Compiler: Ubuntu Clang 20.1.2; host GCC 13.3.0; GNU Make 4.3.
- Analyzer: `build/deadlock-analyzer`, SHA-256 recorded in `reproduced-20261104-final/summary.json`.
- Affected and fixed `.config` hashes match: `789134579dbd3d59491c501b0b78cb166130f9a79327fc8b10b24a59f74b4e56`.
- The machine lacks `ld.lld`; no package was installed. Kbuild host tools used `HOSTLDFLAGS=-fuse-ld=bfd`. The MIPS C object compiled, but the kernel was not linked or booted.

To prepare the pinned worktrees from the repository root:

```sh
python3 evaluation/prepare_historical_case.py
```

Then rebuild and analyze into a new, nonexisting output directory:

```sh
python3 evaluation/run_historical_case.py \
  --analyzer build/deadlock-analyzer \
  --output historical-case/results/my-rerun
python3 evaluation/test_historical_case.py \
  historical-case/results/my-rerun/summary.json
```

The runner verifies both revisions and clean tracked source trees, builds the same translation unit for each, generates a Kbuild compilation database, records build logs and raw analyzer JSON, and refuses to overwrite an existing output directory. It does not alter kernel source files.

## Results

| Measure | Affected: pre-fix parent | Fixed: upstream patch |
|---|---:|---:|
| Translation units | 1 | 1 |
| Functions | 35 | 36 |
| Calls | 239 | 239 |
| Extracted lock operations (acquire / release) | 8 (4 / 4) | 6 (3 / 3) |
| Lock dependencies | 1 | 0 |
| Candidate cycles | 1 | 0 |
| Candidate classification | `inconclusive_analysis` | none reported |
| Uncertainty events | 855 | 892 |
| Unique uncertainty records | 419 | 422 |
| Parser diagnostics | 0 | 0 |
| Analysis time | 0.758 s | 0.783 s |

The affected report contains the same `gic_lock` identity on both ends of an inferred edge from `gic_set_affinity` to `gic_set_type`. Its provenance points to the lock acquisitions at source lines 384 and 307 and the call at line 410. It is reported as `inconclusive_analysis`, because the interprocedural summary is marked uncertain. The source conditions that move affinity between clusters are not represented in the cycle's path conditions.

The fixed source routes the already-locked path to `gic_set_type_locked()`, and the self-cycle disappears. However, the fixed version uses `guard(raw_spinlock_irqsave)(&gic_lock)` in `gic_set_type()`; IRQGuard does not extract that guard as a lock operation. The extracted-operation count therefore falls by a missed fixed-side acquire/release pair. The higher uncertainty count also shows that fewer findings do not mean a more complete analysis.

## Assessment

**Classification: partial match.** IRQGuard finds the upstream-described same-lock recursive pattern in the affected source, preserves call and lock provenance, and no longer reports that cycle in the adjacent fixed source. The affected finding itself remains inconclusive in the analyzer. The unrecognized fixed-side guard prevents a full lock-API accounting match, and no runtime deadlock was reproduced. No precision, recall, or accuracy metric is reported from this one case.

This historical case exercises process-context recursive raw-spinlock acquisition with irqsave semantics; it is not an interrupt-handler lock-order cycle. Its applicability is still strong for the analyzer's lock identity, irqsave extraction, macro location, and interprocedural summary behavior.

## Evidence artifacts

- `reproduced-20261104-final/affected.json` and `fixed.json`: raw analyzer reports.
- `reproduced-20261104-final/summary.json`: revisions, hashes, counts, timings, and result classification.
- `reproduced-20261104-final/affected.log` and `fixed.log`: exact Kbuild, compile-database, and analyzer commands.
- `reproduced-20261104-final/SHA256SUMS`: checksums for the archived reports and summary.

The separate `initial-introduction-to-fix/` local artifacts are explicitly superseded: they compare revisions two years apart and are not used for the result above.

## 8250 serial lock-order inversion

Upstream commit `730037c3ee57f892e6df019bc88d417a5944737c` documents a lockdep-reported lock-order inversion involving the 8250 port lock, IRQ descriptor lock, and the IRQ error-reporting/console path. Its fix moves `disable_irq_nosync()` before taking `port->lock`. The evaluated affected source is the immediate parent `547bbf7d214fff2d29bc885ea7efea0fbc127791`; the fixed source is the one-commit patch.

The official commit contains the lockdep dependency chains and the fix. In the affected source, `serial8250_do_startup()` takes `port->lock` at line 2285 and calls `disable_irq_nosync()` at line 2287. The reverse side flows through IRQ reporting and printk/console code outside `8250_port.c`.

| Measure | Affected | Fixed |
|---|---:|---:|
| Functions / calls | 113 / 645 | 113 / 645 |
| Lock operations | 39 | 39 |
| Dependencies / candidate cycles | 0 / 0 | 0 / 0 |
| Uncertainty events / unique records | 2,865 / 813 | 2,865 / 813 |
| Parser diagnostics | 0 | 0 |
| Analysis time | 0.909 s | 0.881 s |

**Classification: miss.** IRQGuard exposes `disable_irq_nosync()` as an unresolved external call while `port->lock` is held, but does not model its IRQ descriptor lock effect. Its one-translation-unit scope also excludes the reverse IRQ-error and console paths. It consequently produces no dependency or cycle in either source revision. The uncertainty makes the missing effect visible; it does not count as detection of the lockdep pattern.

The full protocol, Kbuild validation limits, and raw report paths are in [`serial8250/REPORT.md`](serial8250/REPORT.md). Machine-readable evidence is in `../evidence/serial8250-startup-lock-order.json`; raw reports, logs, hashes, and measurements are in `serial8250/reproduced-20261104-final/`.

## Combined interpretation

| Historical case | Affected result | Fixed result | Assessment |
|---|---|---|---|
| MIPS GIC recursive `gic_lock` | One same-lock cycle, classified inconclusive | No cycle, but fixed guard acquisition not extracted | Partial match |
| 8250 serial IRQ/port lock-order inversion | No dependencies or cycles; unresolved `disable_irq_nosync` uncertainty | No dependencies or cycles | Miss |

These cases demonstrate one detected pattern with incomplete semantics and one important missed pattern. They are too few and too narrowly selected to support precision, recall, or a general claim of Linux kernel detection quality. No kernel was booted and no runtime deadlock was reproduced by IRQGuard.
