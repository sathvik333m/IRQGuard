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

The original bounded check used CFG reachability but did not retain branch
predicates. Phase 16 extends direct same-function paths with CFG successor
guards for supported `if`, `while`, `do`, and `for` conditions. The guard
normalizer accepts stable scalar local/parameter references and simple
comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`) against similarly stable values.
Exact opposite facts for one declaration can contradict a path, for example
`if (x) acquire(A); if (!x) acquire(B);`. Assignments, address escapes,
volatile/global mutable state, function-call conditions, compound boolean
expressions, switches, and unsupported predicates remain unknown. Conditions
are not conjoined across cycle edges because different edges can arise in
separate invocations or threads.

For each direct dependency, a CFG search begins at the function entry and
tracks whether the source lock has been acquired, released, and reacquired
before the target operation. It retains simple path facts up to 16 atoms and
2,048 states, with an additional work cap of `min(2,048, max(256, CFG blocks *
128))`. Loop back edges clear predicate facts and mark paths that cross
iterations inconclusive; loops are represented by CFG cycles, not unrolled.
A compatible witness is recorded as `cfg_reachable`; an unsupported witness
is inconclusive; a path with only contradictory supported predicates or no
held-lock path is rejected. Interprocedural summary paths retain provenance
but remain unrefined; summaries with unresolved effects or failed convergence
are explicitly inconclusive.

Cycle `feasibility` is additive to the existing stable `category` values:
`candidate` means at least one edge remains unrefined; `potentially_feasible`
means every required edge has compatible supported evidence, while static
assumptions remain; `inconclusive` means material uncertainty affects the
cycle; `rejected` means a required edge is ruled out by a documented modeled
constraint. `independently_confirmed` is never emitted. An interrupt cycle
requires a resolved `request_irq` handler and a modeled IRQ-enabled process
snapshot, but registration execution, interrupt delivery, and lifetime are not
proven. An exact `free_irq` IRQ/device argument match is exported as
deregistration evidence only; it does not establish ordering or retire the
handler. `irqrestore` continues to use the saved flags state, and paths with
unknown IRQ state remain inconclusive. No numeric confidence score is used.

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
