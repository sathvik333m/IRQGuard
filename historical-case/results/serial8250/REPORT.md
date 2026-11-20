# 8250 serial startup lock-order case

## Independent evidence

Upstream commit `730037c3ee57f892e6df019bc88d417a5944737c` changes the lock order in `serial8250_do_startup()`. Its commit message includes lockdep reports for conflicting order between `uart->port->lock` and `irq_desc_lock_class`, along with the console-lock path that reaches the port lock while reporting an IRQ error. The fix calls `disable_irq_nosync()` before taking `port->lock`, aligning the order with the other path. The commit links the [upstream fix](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=730037c3ee57f892e6df019bc88d417a5944737c) and [patch discussion](https://lore.kernel.org/lkml/20200817022646.1484638-1-sergey.senozhatsky@gmail.com/).

The affected snapshot is the immediate parent, `547bbf7d214fff2d29bc885ea7efea0fbc127791`; the fixed snapshot is the one-commit patch above. The lockdep report includes a three-lock chain involving `console_owner`, `port_lock_key`, and `irq_desc_lock_class`, plus the concrete reverse lock order in two paths.

## Reproduction

The analyzed translation unit is `drivers/tty/serial/8250/8250_port.c` at each revision. The build used the same `x86_64_defconfig` configuration hash, Clang 20.1.2 for the kernel C object, GCC 13.3.0 host tools, and a generated Kbuild compilation database. The old source's objtool helper fails under GCC 13 because its `-Werror` build diagnoses `use-after-free` in host-side `tools/objtool/subcmd-util.h`. The runner therefore explicitly skipped objtool/ORC stack validation and did not link the kernel. The generic Kbuild warning says to install libelf, but the actual blocker here is the old objtool/GCC warning; this is recorded in both build logs and the run summary.

Reproduce from the repository root:

```sh
python3 evaluation/prepare_historical_case.py
python3 evaluation/run_serial8250_case.py \
  --analyzer build/deadlock-analyzer \
  --output historical-case/results/serial8250/my-rerun
python3 evaluation/test_historical_serial8250.py \
  historical-case/results/serial8250/my-rerun/summary.json
```

The runner validates source commits and tracked-file cleanliness, requires a new output directory, compiles the target object, generates the compile database from the pinned Kbuild `.cmd` records, and stores logs plus raw JSON reports. It does not modify the kernel source.

## IRQGuard result

| Measure | Affected | Fixed |
|---|---:|---:|
| Functions | 113 | 113 |
| Calls | 645 | 645 |
| Extracted lock operations | 39 | 39 |
| Lock dependencies | 0 | 0 |
| Candidate cycles | 0 | 0 |
| Uncertainty events | 2,865 | 2,865 |
| Unique uncertainty records | 813 | 813 |
| Parser diagnostics | 0 | 0 |
| Analysis time | 0.909 s | 0.881 s |

**Classification: miss.** The affected report records a call to external `disable_irq_nosync()` while `serial8250_do_startup()` holds `port->lock`, and emits uncertainty that this unmodeled call may affect lock and IRQ state. It does not model the IRQ descriptor lock acquired by that API. The second edge comes from the IRQ-reporting and console path in other translation units, outside this run's source scope. Consequently, IRQGuard emits neither a dependency nor a candidate cycle in either version.

This case is an independently documented lockdep warning, not a deadlock reproduced by this project. The zero-cycle output is a real miss and is retained as such. It does not establish that the fixed report is safer because the analyzer sees no cycle on either side.

The source-tree lockdep report, compilation database hashes, raw analyzer JSON, build logs, and run metadata are in `reproduced-20261104-final/`. The combined case catalog is in `../../evidence/serial8250-startup-lock-order.json`.
