# Phase 4 design: cycle findings and feasibility refinement

Phase 4 consumes the Phase 3 context-labelled lock graph. It keeps the graph's
execution model and adds explainable cycle categories and a small feasibility
refinement. It does not replace the Clang AST/CFG analyzer, prove a deadlock, or
reproduce Archerfish.

## Cycle discovery and reporting

The analyzer uses bounded depth-first search to reconstruct closed edge paths.
Process-only paths are searched over process regular edges. Interrupt-aware
paths must begin with a process-to-hardirq preemption edge and continue through
regular edges belonging to that same registered handler. Restricting a path to
one handler avoids combining unrelated handler edges. Search depth remains
bounded at 24 and result count at 256; hitting either cap is reported as an
uncertainty.

Cycles are grouped by their ordered lock identity, context transition, and edge
kind sequence modulo rotation. The acquisition order is not reversed during
canonicalization. The representative edge chain is accompanied by alternate
edge-index provenance variants, and each representative edge retains source
locations, functions, handler registration and call provenance. JSON includes
the closed `lock_sequence` and edge objects. Text output prints each lock edge
with its function and source line. `--format dot` renders the dependency graph;
interrupt preemption edges are red and rejected hypothetical edges are dashed
gray.

## Feasibility refinement and categories

Findings use one of four `category` values:

| Category | Meaning |
| --- | --- |
| `candidate_lock_order_cycle` | A process-context order cycle with no known contradictory IRQ fact. |
| `interrupt_aware_candidate` | A process/hardirq cycle where the process-side state may permit hardirq preemption. |
| `rejected_candidate` | A counterfactual interrupt cycle rejected because local hard IRQs are definitely disabled at the process acquisition. |
| `inconclusive_analysis` | A reconstructed cycle includes an uncertain edge, such as a path-dependent IRQ state. |

The rejected finding includes a synthetic `interrupt_preemption_rejected`
edge so the user can inspect the counterfactual cycle shape. It is not part of
the executable dependency graph: its `feasibility` is `rejected`, its IRQ state
is `disabled`, and its reason states the modeled same-CPU hardirq preemption
assumption. The separate edge kind prevents it from being mistaken for an
observed lock dependency.

This phase's bounded feasibility check uses CFG-derived IRQ state at acquisition
points, handler-scoped graph paths, and an event-level CFG reachability check
for direct same-function dependencies. That check searches from the source
acquisition to the target while tracking whether the source lock is released;
its per-function work limit is `max(256, CFG block count * 128)`. A found path
is labeled `cfg_reachable`, not semantically feasible, because correlated
branch predicates are not evaluated. A path that
cannot reach the target before release rejects that dependency and any cycle
that relies on it. Interprocedural dependencies are retained with their call
provenance because a full expanded call-path feasibility check is not yet
implemented. A join of enabled and disabled IRQ paths remains `unknown`, so a
cycle using it becomes `inconclusive_analysis`. The analyzer does not combine
branch predicates or claim that individually reachable edges occur in the same
invocation. Correlated predicates such as `if (x) acquire(A); if (!x)
acquire(B);` are therefore not proven exclusive; such dependencies remain
possible. Where path correlation, lock aliasing, registration lifetime, or
target resolution is needed, the result remains a candidate/inconclusive
finding with uncertainty rather than being declared feasible or safe. No
numeric confidence score is used.

## Explicit limits

- Branch conditions are not translated to predicates, and there is no SMT
  solver. The CFG supports reachability and IRQ-state joins only.
- The analyzer does not prove registration-before-use, interrupt delivery,
  cross-CPU scheduling, lock ownership, or lock initialization.
- Unresolved lock identities and indirect handler targets limit the refinement.
- Cycle and graph caps can omit findings; cap hits are recorded as uncertainties.
- Findings are static candidates, rejected modeled shapes, or inconclusive
  analyses. None is labeled a confirmed runtime deadlock.

## Reproduction

```sh
cmake --build build
ctest --test-dir build --output-on-failure
build/deadlock-analyzer analyze --source tests/fixtures/interrupts.c --format json
build/deadlock-analyzer analyze --source tests/fixtures/interrupts.c --format dot --output /tmp/interrupt-locks.dot
```
