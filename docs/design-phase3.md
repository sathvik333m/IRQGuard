# Phase 3 design: interrupt-aware lock analysis

This phase adds a scoped interrupt model on top of the Phase 1 Clang AST/CFG facts and Phase 2 interprocedural lock summaries. Its output is a set of context-labelled lock edges and static cycle candidates. It does not reproduce Archerfish or confirm runtime deadlocks.

## Relationship to Archerfish

The design is inspired by the four stages in Ye, Cai, and Zhang, “When Threads Meet Interrupts,” USENIX Security 2024 ([paper](https://www.usenix.org/system/files/usenixsecurity24-ye.pdf), especially §§3.2 and 5.1–5.4):

| Archerfish concept | This implementation |
| --- | --- |
| ISR identification using modeled registrations plus subsystem/interface specifications | AST extraction of configured registration APIs, initially `request_irq`, with a resolvable handler argument. No LLM-generated or callback-interface specifications. |
| Flow/context-sensitive lockset and interrupt-state summaries | Reuses Phase 2 lock summaries; adds CFG IRQ-state summaries with interprocedural state transfer and saved-flag identities. The abstract IRQ state is enabled, disabled, or unknown. |
| Preemption units | Emits snapshots after lock acquisitions instead of clustering critical sections into Archerfish preemption units. This is smaller and easier to inspect, but can create more candidate edges. |
| Interrupt-aware lock graph and cycle discovery | Builds context-labelled regular edges and process-to-hardirq preemption edges, then performs bounded cycle searches. |
| Registration happen-before and SMT path-feasibility validation | Only the IRQ-state condition is used to suppress preemption edges. No registration temporal proof, path predicates, SMT solving, or full cycle feasibility validation. Every cycle is a candidate. |

Archerfish models hardirq and softirq contexts, broad Linux API families, richer ISR discovery, preemption-unit summaries, registration happen-before, and path feasibility. This project currently models process and hardirq contexts only. The paper discusses that hardirqs normally run with local interrupts disabled and that `irqsave`/`irqrestore` save and reload interrupt state; the transfer below follows that semantic distinction rather than treating restore as enable.

## Supported API and context subset

Built-in semantic models:

| API | Effect |
| --- | --- |
| `mutex_lock`, `spin_lock` | Acquire the configured lock identity; do not change hard-IRQ state. |
| `mutex_unlock`, `spin_unlock` | Release the configured lock identity. |
| `spin_lock_irqsave(lock, flags)` | Save the current abstract IRQ state under the symbolic identity of `flags`, disable local hard IRQs, then record the acquisition snapshot. |
| `spin_unlock_irqrestore(lock, flags)` | Release the lock and restore only the state saved under the matching symbolic `flags` identity. No match produces unknown state and an uncertainty. |
| `spin_lock_irq`, `spin_unlock_irq` and selected raw variants | Acquire/release the lock and model local hard IRQs as disabled/enabled for the matching pair. |
| Public and selected raw `irqsave`/`irqrestore` variants | Recognize the source macro invocation from its Clang expansion-site token. For return-flags helpers, recover the saved-state lvalue from the enclosing assignment AST when available; otherwise IRQ state stays unknown and an uncertainty is emitted. |
| `local_irq_save(flags)`, `local_irq_restore(flags)` | Save and restore the abstract state using the structural identity of `flags`. A missing or unresolved identity yields unknown state and an uncertainty. |
| `local_irq_disable`, `local_irq_enable` | Set local hard-IRQ state to disabled or enabled respectively. |
| `request_irq(irq, handler, ...)` | Register a resolvable handler as a possible hardirq root. Direct function expressions and the Phase 1/2-supported local function-pointer assignments are recognized. |
| `free_irq` | Recognized as teardown, but lifecycle timing is not modeled; an uncertainty is emitted and the handler remains a possible target. |

The API registry supports `state_argument` and `handler_argument` indexes in addition to `lock_argument`. For function-like macros, the visitor uses Clang's expansion location to read the invocation token and matches that exact token against the API registry. The expanded helper is used when no registered public token is available. It does not search arbitrary source substrings. Calls to locally defined wrappers are summarized interprocedurally rather than mislabeled as unknown external APIs. Other unresolved calls whose names contain `lock` or `irq` remain visible as possibly unsupported APIs; that name heuristic is only a warning aid and is not the parser. The built-in macro aliases are scoped to the Linux v6.6.87 expansion shape examined during Phase 9; other kernel versions may need explicit registry entries.

At process-context roots, local hard IRQs start enabled. At a registered hardirq handler and functions reachable from it through resolved calls, they start disabled. A function reachable in both ways is analyzed in both contexts. A hardirq cannot be preempted by another hardirq in this model, matching the usual Linux hardirq local-disable assumption. Softirq, NMI, threaded IRQ, tasklet, timer, cross-CPU scheduling, and lock-class/IRQ-line priority distinctions are outside this phase.

## IRQ state and interprocedural summaries

Each CFG state contains an IRQ-state term and a map from symbolic flag expressions to saved terms. Terms are `enabled`, `disabled`, `unknown`, the function input `$in_irq`, or an input saved flag `$in_flag[n]`. Function summaries preserve the output IRQ term, flag effects derived from formal parameters, lock-acquisition snapshots, and uncertainty strings. The summary fixed point is bounded to 128 rounds; CFG iteration has a per-function bound. Non-convergence and missing CFG events are reported.

At an IRQ-state transition, the analyzer applies a strong update. At a CFG join, equal states remain known and differing states become `unknown`; differing or missing saved-flag facts also become unknown. This is a may-enabled policy: an unknown state retains a preemption candidate marked uncertain instead of suppressing it as if disabled. For nested save/restore, an inner save records the already-disabled state, so the inner restore keeps IRQs disabled; only the outer restore can restore the prior enabled state.

Call summaries substitute symbolic actual arguments. Unknown or external calls may alter IRQ state, so they set the state and saved flags to unknown and produce uncertainty. A function-pointer call with multiple known targets unions snapshots and joins state effects conservatively; unresolved candidates retain uncertainty.

## Graph construction and findings

Phase 2 lock dependencies become `regular` edges tagged with `process` or `hardirq` context. For an acquisition snapshot in process context, the analyzer considers the newly acquired lock and the lock identities held before it (from the Phase 2 dependencies targeting that acquisition). If IRQ state is enabled or unknown, each registered handler acquisition contributes a `process` → `hardirq` `interrupt_preemption` edge. Disabled snapshots produce no such edge. Edges retain lock identities, source locations, registration location, handler, call provenance, contexts, IRQ state, and certainty.

Cycle searches are intentionally restricted. Process-only regular cycles are reported as `normal_lock_cycle`. An interrupt candidate requires a process-to-hardirq preemption edge followed by hardirq regular dependencies back to the held lock. It is therefore not enough to combine unrelated process and handler edges into a cycle. The graph is capped at 100,000 edges, search depth at 24, and output at 256 cycles; caps are reported as uncertainties. Cycles involving hardirq-only lock-order cycles without a process preemption edge are not currently emitted.

The analyzer does **not** prove that a registration executes before a candidate preemption point. Every resolved registration is treated as potentially active throughout the translation unit; `free_irq` does not retire it. It also does not prove path feasibility, alias relationships, lock initialization, lock ownership, same-CPU device delivery, or that the handler will be triggered. Thus a cycle means “possible under the stated model,” not a validated deadlock.

## Limitations and validation assumptions

- The input remains one Clang translation unit. Included definitions outside the main file are generally unavailable to the summaries.
- Handler argument discovery supports direct function references and simple function-pointer variables with known direct assignments. Callback registries and arbitrary points-to flows are unresolved.
- Lock identity is Phase 2's structural symbolic identity. Aliases can be missed and unresolved identities remain uncertain; handler data pointers such as `dev_id` are not bound to registration arguments.
- `irqsave` flags must have a matching structural identity at restore. Casts, aliasing, memory stores, inline assembly, and compiler-specific macro expansion may make state unknown or hide the API call.
- The model treats `local_irq_enable` as an explicit enable. It does not model CPU-specific IRQ flags, `irq_set_irq_type`, IRQ affinity, preempt counts, bottom halves, or nested/disabled subsets.
- CFG branch joins are path-insensitive. The tests use reachable, controlled branches to verify that enabled/disabled merges become unknown, not to claim path feasibility.
- The tests validate this API subset using C fixtures and the installed Clang frontend. They do not validate the full Linux kernel, and no kernel module or host-kernel experiment is performed.

## Reproduction

```sh
cmake --build build
ctest --test-dir build --output-on-failure
build/deadlock-analyzer analyze --source tests/fixtures/interrupts.c --format json
```
