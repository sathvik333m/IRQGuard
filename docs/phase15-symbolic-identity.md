# Phase 15 — High-impact uncertainty and symbolic identity

## Scope and evidence status

This phase tightens symbolic identity and interprocedural effect propagation while retaining the Clang AST/CFG pipeline. It does not implement a general points-to analysis and does not establish deadlocks in Linux.

The pre-change repository revision was `8a27098eefc9d0501b01230b39db660dbe5fd201` (Phase 14, clean tree before Phase 15 edits). The saved Phase 13 comparison used Linux stable `v6.6.87`, commit `814637ca257f4faf57a73fd4e38888cce88b5911`, and five selected e1000e translation units. The checkout was initially missed because it was under `/home/sathvik/`, not at the old `/tmp/linux-v6.6.87` path. It has now been moved into `third_party/linux-v6.6.87/`, verified clean at the pinned commit, and used for a fresh Phase 15 rerun. See [the Phase 15 kernel report](../evaluation/results/linux-v6.6.87/phase15-report.md), plus `evaluation/results/phase15/baseline/` for pre-change reports.

The saved Phase 13 summary classifies the earlier run as 43,514 raw uncertainty events, 4,833 unique classified records, and 38,681 propagation events. The 4,833 records comprise:

| Category / stage | Events | Unique records |
|---|---:|---:|
| Unresolved call / interprocedural | 21,674 | 2,352 |
| Interrupt state / interrupt state | 21,674 | 2,352 |
| Unsupported API / API model | 121 | 121 |
| Handler lifecycle / handler discovery | 41 | 6 |
| Control flow / control flow | 4 | 2 |

The summary marks 2,582 unique records high impact under the existing classifier. It associates zero records with candidate cycles because this archived report has zero current cycles. This association is not proof that the uncertainties are harmless. The offline aggregation covered 690 function buckets and 2,213 source-location buckets; function buckets can include both summary and context-qualified entries. The largest event bucket is `__ew32_prepare` (5,811 events, 3 unique records), largely repeated summary propagation. These are classification counts, not independent bug counts.

The saved Phase 13 run extracted 12 lock API operations (six acquisitions and six releases, including two irqsave/restore pairs), zero dependency edges/cycles, and two parser diagnostics. The Phase 9.0 report's 43,705-event count is earlier and not directly comparable because intervening fixes changed the analyzer. A fresh Phase 15 run has now been completed; its exact before/after counts and interpretation follow in the [kernel evaluation report](../evaluation/results/linux-v6.6.87/phase15-report.md).

## Findings and changes

### Lock identity

The AST extractor now resolves a narrow set of local pointer aliases when the initializer has a supported identity and the alias is neither reassigned nor address-escaped. This covers aliases of formal parameters, global locks, and structure members. It canonicalizes `&*p` to `p`, `*&p` to `p`, and `(*p).member` to `p->member`.

Uninitialized, mutable, escaping, conditional, casted, pointer-arithmetic, pointer-returning-member/subscript, and otherwise unsupported pointer expressions remain unresolved. They receive a location-specific unknown identity and a high-impact `lock_identity` uncertainty. This avoids claiming that two structurally similar expressions are the same object. No general alias solver is implemented.

Interprocedural substitution preserves caller-owned lock identities across wrapper calls and scopes only callee-local automatic objects. Actual arguments with unresolved identities remain unresolved through summaries. This lets two call sites using distinct instances of the same structure remain distinct, while repeated calls using the same caller object preserve its identity.

The preserved controlled fixture demonstrates the prior defect: three parameter/global/member pointer-alias functions each returned one falsely held lock because acquire and release identities differed. After the change, each returns with no held lock. A reassigned pointer remains unresolved and emits an explicit uncertainty. One test now also verifies a real self-order candidate when a helper reacquires the exact caller-owned lock already held.

### irqsave / irqrestore and wrappers

The fixture models a kernel-style `spin_lock_irqsave` macro expanding through `_raw_spin_lock_irqsave(spinlock_check(lock), flags)`. The operation is recognized at the macro invocation/expansion site; the known `spinlock_check` operand is unwrapped only as an identity-preserving validation wrapper. It is not treated as a lock acquisition itself. This uses AST call and parent/argument structure plus exact modeled names, not arbitrary substring matching.

Interprocedural IRQ summary instantiation now preserves the caller's saved-state identity instead of re-scoping it as a callee local. If the `irqsave` flags expression cannot be represented or the corresponding `irqrestore` state is unmatched at the call site, the analyzer emits an explicit high-impact uncertainty. The abstract transition remains save-current-state then disable, and restore from that saved value; it is not rewritten as an unconditional enable.

Tests cover nested wrapper calls with independent flags, restoration order, two locks, a conditional/reassigned flags pointer, macro-expanded APIs, and identity-preserving wrappers. A fresh Clang AST dump from the pinned e1000e build command also confirmed the real `spin_lock_irqsave` expansion: the source call at `netdev.c:501` becomes `_raw_spin_lock_irqsave` in `include/linux/spinlock.h:244`, with a nested `spinlock_check` at header line 381. The analyzer report retains the source expansion location and resolves the matching restore at `netdev.c:503`. Full run details and the second pair at lines 3935/3938 are in the [Phase 15 kernel report](../evaluation/results/linux-v6.6.87/phase15-report.md).

### Summaries and uncertainty output

Summaries continue to represent acquired/released locks, dependencies, saved IRQ-state terms, and unresolved effects. Substitution is call-site-specific, but path predicates and general pointer aliasing are not modeled. Recursive summaries and may/must effects retain the prior bounded abstraction.

Schema-v4 JSON gains additive `uncertainty_summary.by_function` and `by_source_location` groupings with total events, unique records, and category/stage subcounts. The offline summarizer emits matching aggregates. Raw uncertainty event strings and unique records remain present; the new grouping is not suppression. The schema version remains 4 because fields are additive.

## Reproduction commands

From the repository root, using the configured LLVM/Clang 20 development packages:

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure
build/deadlock-analyzer analyze --source tests/fixtures/symbolic_identity.c --format json --output /tmp/irqguard-symbolic-identity.json
build/deadlock-analyzer analyze --source tests/fixtures/kernel_lock_api_macros.c --format json --output /tmp/irqguard-kernel-macros.json
python3 evaluation/run_kernel_eval.py --kernel third_party/linux-v6.6.87 --analyzer build/deadlock-analyzer --llvm /usr/lib/llvm-20/bin --output evaluation/results/linux-v6.6.87/phase15-rerun --jobs 2
python3 evaluation/summarize_uncertainties.py evaluation/results/linux-v6.6.87/phase15-rerun/reports /tmp/phase15-uncertainty-summary.json
```

The kernel command performs the fresh pinned-source analysis and bounded object validation. The final command reclassifies those fresh per-file reports and writes the grouped uncertainty summary. The Phase 13 and Phase 15 generated compile databases contain the same 11 normalized compiler command argument sets; the kernel config hashes and Clang versions also match.

## Verification performed

- `cmake --build build -j2`: passed.
- `ctest --test-dir build --output-on-failure`: 16/16 passed, including extraction, interprocedural summaries, IRQ model, uncertainty reporting, prior phase regressions, runtime evidence and CLI integration.
- Targeted reports in `evaluation/results/phase15/after/` were generated from the updated analyzer for the controlled fixtures.
- Fresh Phase 15 kernel measurements are available in `evaluation/results/linux-v6.6.87/phase15-report.md` and `phase15-raw-measurements.json`; the report archive and grouped uncertainty summary are stored alongside them.
- The saved Phase 13 run had 43,514 uncertainty events / 4,833 unique records. The fresh run has 43,632 / 4,922. The increase is 118 events / 89 unique high-impact lock-identity records from unresolved adapter pointer propagation, not a suppressed warning or an accuracy improvement.
- The native suite passed 16/16 after the kernel run. The website suite passed 17 tests and the production build succeeded. `node --check backend/server.mjs` passed.
- A local HTTP smoke test could not bind in this execution sandbox (`listen EPERM` on loopback); the backend-to-browser request was not verified here. The UI test uses the endpoint response contract fixture, and the comparison JSON was parsed directly.

## Limitations and next validation

- The fresh run used the moved pinned checkout and generated a fresh compile database. A filtered Clang AST dump confirmed the selected macro expansion shape; alternate kernel configurations and other compiler versions remain untested.
- Alias resolution is local and deliberately conservative; pointer fields, escaped aliases, casts, conditional pointers and general interprocedural aliasing remain unresolved.
- IRQ flag relationships through memory, inline assembly, unusual macros, or unsupported alias forms remain unknown and are reported as such.
- Uncertainty categories and unique-cause grouping are heuristic classifications; event/unique counts are not false-positive rates.
- A zero candidate association in saved output does not prove the uncertainty has no effect on unreported or missed cycles. The fresh run still reports zero dependencies and cycles, so no cycle feasibility conclusion can be drawn from this selected subsystem.
