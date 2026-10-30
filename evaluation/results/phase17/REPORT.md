# IRQGuard Phase 17 Evaluation Run

Dataset: `irqguard-phase17-v1`
Analyzer SHA-256: `d9763ff0da235e49e78ef7c736ac9ed880d127a6b5a6a45843ca84bfab3b0b35`

Kernel checkout validation: `matched` (/home/sathvik/os_project/third_party/linux-v6.6.87).

Controlled fixture assertions: **8 passed, 0 failed**.

## Controlled fixtures

| Case | Group | Result | Measured cycles | Dependencies | Uncertainty events |
|---|---|---:|---:|---:|---:|
| `syn-positive-normal-cycle` | synthetic_positive | passed | 4 | 12 | 9 |
| `syn-positive-interrupt-cycle` | synthetic_positive | passed | 5 | 13 | 8 |
| `syn-negative-exclusive-branches` | synthetic_negative | passed | 4 | 12 | 9 |
| `syn-negative-release-before-next-acquire` | synthetic_negative | passed | 5 | 13 | 8 |
| `edge-irqsave-restore-macro` | edge_case | passed | 0 | 5 | 8 |
| `edge-saved-irqstate-pair` | edge_case | passed | 4 | 12 | 9 |
| `edge-locking-wrapper` | edge_case | passed | 5 | 13 | 8 |
| `edge-interprocedural-symbolic-lock` | edge_case | passed | 1 | 4 | 4 |

Fixture analyzer process measurements (one run per distinct source):

| Source | Time | Peak RSS |
|---|---:|---:|
| `tests/fixtures/interrupts.c` | 0.03508 s | 80940 KiB |
| `tests/fixtures/kernel_lock_api_macros.c` | 0.026631 s | 81828 KiB |
| `tests/fixtures/phase16_feasibility.c` | 0.032918 s | 81096 KiB |
| `tests/fixtures/symbolic_identity.c` | 0.023295 s | 80796 KiB |

## Linux v6.6.87 exploratory observations

These values come from the fresh Phase 17 kernel run.

| Case | Status | Functions | Lock ops | Dependencies | Cycles | Uncertainty events | Time | Peak RSS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `kernel-e1000e-netdev-v6.6.87` | fresh_phase17_observation (unlabeled) | 154 | 10 | 0 | 0 | 29269 | 2.572 s | 240964 KiB |
| `kernel-e1000e-ethtool-v6.6.87` | fresh_phase17_observation (unlabeled) | 51 | 0 | 0 | 0 | 1806 | 1.068 s | 134636 KiB |
| `kernel-e1000e-ich8lan-v6.6.87` | fresh_phase17_observation (unlabeled) | 98 | 2 | 0 | 0 | 6880 | 1.319 s | 151272 KiB |
| `kernel-e1000e-phy-v6.6.87` | fresh_phase17_observation (unlabeled) | 76 | 0 | 0 | 0 | 5005 | 1.117 s | 135520 KiB |
| `kernel-e1000e-nvm-v6.6.87` | fresh_phase17_observation (unlabeled) | 17 | 0 | 0 | 0 | 672 | 0.918 s | 132328 KiB |

## Interpretation

No precision or recall is calculated: the real-kernel cases have no independent labels. A zero cycle count means only that this bounded analyzer/report contained no cycle for that translation unit. It does not show that the code is deadlock-free. See `docs/phase17-evaluation.md` for tool-model differences, provenance and reproduction steps.

## Linux aggregate

The Phase 17 fresh run records 5/5 files analyzed; 396 functions; 12 lock operations; 0 dependencies; 0 cycles; 43632 uncertainty events; 2 diagnostics. Unique uncertainty records summed across translation-unit reports (not cross-file deduplicated): 4922.

Uncertainty by category (event / per-report unique-record sums):

- `control_flow`: 4 / 2
- `handler_lifecycle`: 41 / 6
- `interrupt_state`: 21674 / 2352
- `lock_identity`: 118 / 89
- `unresolved_call`: 21674 / 2352
- `unsupported_api`: 121 / 121

Build and environment evidence:

- Kernel commit: `814637ca257f4faf57a73fd4e38888cce88b5911`
- Clang: Ubuntu clang version 20.1.2 (0ubuntu1~24.04.3)
- Kbuild config SHA-256: `488d466afc9efc70b31b8025cb664cb757b6079ba68e57246bb37d5f2d136cd1`
- Selected object compilation: `succeeded`
- Objtool object checks: `succeeded`
- ORC sections present: `True`
- Final module link: `not_attempted; composite object target only`
- Separate stack validation: `not_configured_by_defconfig`
