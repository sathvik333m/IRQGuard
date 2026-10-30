# Phase 16 — Feasibility review and implementation scope

## Review before changes

The existing pipeline already uses Clang CFGs for interprocedural summaries
and IRQ-state dataflow. A CFG block stores call events and successor block IDs,
but not the condition or polarity selecting each successor. The API also
exports a flat list of control constructs; that list is not attached to lock
events or graph edges.

`refineDirectDependencies` in `src/InterruptAnalysis.cpp` searches the CFG from
one acquisition to another while treating the source lock as held. It stops a
path at a matching release and is bounded by `max(256, blocks * 128)` work
items. A found path is only CFG-reachable: correlated predicates are not
checked. A missing path is marked rejected. Interprocedural dependencies skip
this refinement and retain call provenance. The cycle finder then combines
edges by lock identity and context, with depth 24 and at most 256 findings. A
cycle using an uncertain edge is inconclusive; a cycle using a rejected direct
edge is retained as rejected evidence.

IRQ state is tracked as enabled, disabled, unknown, or symbolic saved state.
Joins that disagree become unknown. A process-to-hardirq edge is omitted when
local hard IRQs are definitely disabled at the acquisition. IRQ handler roots
come only from statically resolved `request_irq` targets. A registration is
treated as possibly active throughout the translation unit; `free_irq` emits
an uncertainty but is not associated with a registration and does not retire
the handler. The analyzer does not prove registration ordering or actual
delivery. Runtime trace data is a separate subsystem and is not used by static
classification.

## Evidence before changes

Repository revision `4186700cee7afda4cc38fc35eedb21ffb9f9153e` and the initial
working tree were inspected before edits. The Phase 15 working tree was clean.
Baseline commands:

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure
```

The build reported `ninja: no work to do`. CTest passed 16/16 tests (4.08 s).
These are regression results, not accuracy metrics.

## Phase 16 design boundary

The extension preserves existing graph nodes, edge kinds, categories,
and JSON schema version. Additive CFG edge guards cover supported `if`,
`while`, `do`, and `for` branches when the condition reduces to a simple
boolean variable or comparison. A bounded event-path search will track at most
16 distinct condition atoms and 2,048 states per dependency. Exact opposite
guards for the same declaration can prove a path contradictory; complex,
side-effecting, switch, and otherwise unnormalized conditions stay unknown.
Loops use the CFG cycle and the same state cap; they are not unrolled to an
arbitrary iteration count.

Only direct same-function acquisition pairs are eligible for this predicate
refinement. Interprocedural summary dependencies retain their evidence but
remain unrefined because their branch conditions are not currently summarized.
Conditions are checked within one acquisition-to-acquisition path, not
conjoined across cycle edges: edges may arise in separate executions or
threads. IRQ preemption checks continue to use the acquisition's IRQ-state
snapshot and a resolved registration edge. Registration/deregistration
argument matches will be recorded as evidence only; they will not prove call
ordering, lifetime, or handler inactivity.

`feasibility` distinguishes `candidate` (cycle graph exists but an edge is
unrefined), `potentially_feasible` (available direct path evidence is
compatible, with static assumptions remaining), `inconclusive` (material
identity, predicate, summary, IRQ, or registration evidence is unresolved),
and `rejected` (a supported contradiction rules out an edge required by the
cycle). No static output will use `independently_confirmed`. Existing category
values remain stable. Every rejection must carry an edge-level reason and be
visible in the cycle explanation.

Risks include false rejection if a condition is normalized unsafely, false
feasibility if aliases or summaries are incomplete, and increased state work
on loops. The implementation recognizes only explicit AST-supported forms,
retains unknown guards, and caps paths. Controlled tests cover supported and
unsupported conditions, loop paths, IRQ state, and registration-lifecycle
evidence; broader kernel claims are not made from these fixtures.

## Implemented behavior and verification

The model now stores a branch guard alongside each CFG successor while keeping
the existing successor IDs, graph edge kinds, finding categories, and schema
version 4. JSON graph edges include `path_condition_status`, source-located
`path_conditions`, `summary_status`, and registration-lifecycle evidence.
`interrupt_deregistrations` records `free_irq` arguments and any exact
IRQ/device argument matches to `request_irq` sites. An argument match is not
treated as proof of temporal ordering, and matching registrations remain
possible hardirq roots.

The cycle `feasibility` values now mean:

| Value | Meaning |
| --- | --- |
| `candidate` | A graph cycle exists, but at least one required edge is unrefined. |
| `potentially_feasible` | Every edge has a compatible supported path witness under the modeled assumptions. This is not independent confirmation. |
| `inconclusive` | Unsupported branch facts, lock identity, summary effects, IRQ state, or bounded search prevent a decision. |
| `rejected` | A required edge has no held-lock path or all candidate paths contradict supported predicates; interrupt-disabled counterfactual shapes are also rejected under the documented same-CPU model. |

No finding is emitted as independently confirmed. The category field continues
to use the previous values (`candidate_lock_order_cycle`,
`interrupt_aware_candidate`, `rejected_candidate`, and
`inconclusive_analysis`). The GUI and text/JSON output now show feasibility
evidence and handler lifecycle assumptions.

The controlled fixture `tests/fixtures/phase16_feasibility.c` covers a
contradictory direct path and rejected cycle, complementary comparisons,
opposite branch orders that remain compatible across separate calls,
nested conditions, early-return control flow, an unknown function-call condition, a loop path,
reassigned conditions, an incomplete interprocedural summary, resolved and
unresolved IRQ handlers, an exact registration/deregistration argument match,
and saved `irqsave`/`irqrestore` behavior. Earlier tests continue to cover
multiple handler roots, interrupt-disabled rejection, nested flags, and source
provenance.

Commands and actual results after implementation:

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure
python3 tests/test_phase16_feasibility.py build/deadlock-analyzer tests/fixtures/phase16_feasibility.c
cd web && npm test
cd web && npm run build
```

- C++ analyzer build: passed.
- CTest: 17/17 passed (3.83 s), including the new `analyzer_phase16_path_feasibility` test.
- Focused Phase 16 test: passed.
- Website tests: 17/17 passed.
- Website production build: passed.
- `git diff --check`: run as part of final review.

This phase did not rerun the pinned Linux subsystem evaluation. The new
behavior is validated on controlled source fixtures, and previous kernel
measurements must not be presented as Phase 16 results.

## Remaining limitations

- Predicate facts are local to one direct same-function lock path. They are
  not propagated through function summaries and are not conjoined between
  cycle edges, because edges can describe separate thread executions.
- Conditions with side effects, compound Boolean operators, pointer/member
  dereferences, `switch`, mutable or escaped variables, volatile values, and
  unrecognized Clang CFG shapes remain inconclusive.
- The normalizer does not evaluate arithmetic ranges, aliases, temporal state,
  or arbitrary C expressions. A supported path witness establishes only
  plausibility under this abstraction.
- Loop back edges clear path facts and make paths crossing iterations
  inconclusive. No loop unrolling or induction-variable reasoning is done.
- `free_irq` matching uses exact source argument text. It does not establish
  that either call executes, that teardown precedes a lock attempt, or that an
  interrupt has been delivered.
- The analyzer does not model all lock ownership, CPU affinity, interrupt
  delivery behavior, softirq/NMI contexts, registration happens-before, or
  runtime deadlock evidence. Static findings remain separate from runtime
  observations.
