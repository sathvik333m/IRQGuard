# Phase 11 — Archived Linux cycle review

## Scope and reproducibility status

This review examines the three cycles in the preserved Phase 9.0 `netdev.json`
report for Linux `v6.6.87`, commit
`814637ca257f4faf57a73fd4e38888cce88b5911`. The input report SHA-256 is
`1413deebf409eb04a7c0a22e7eae35fc7d33897f69fd080bafa3095f54ba489c`.
The report predates the Phase 9 extraction fix. Phase 12 subsequently restored
the pinned source and reran the current analyzer on all five selected files.
That source-only run emitted zero lock dependencies and zero cycles; it
explicitly skipped objtool and ORC metadata generation because `libelf-dev`
could not be installed in the restricted environment. This is the current
tool output, not evidence that the driver is deadlock-free. The three archived
cycles remain individually classified as inconclusive and were not re-labeled
as rejected based only on their disappearance from the new graph.

Recreate this retrospective artifact from the preserved inputs:

```sh
python3 evaluation/review_cycles.py
python3 evaluation/test_review_cycles.py
```

The generated JSON is
[`../evaluation/results/linux-v6.6.87/cycle-review-phase11.json`](../evaluation/results/linux-v6.6.87/cycle-review-phase11.json).
The generator joins the archived per-cycle review with the separate current
source-only run at `evaluation/results/linux-v6.6.87/phase12/`; it keeps the
archived cycle records distinct from current-run counts. See the
[Phase 12 build-validation report](../evaluation/results/linux-v6.6.87/phase12-report.md)
for why full objtool validation remains incomplete.

## Classification meanings

- **Candidate:** a modeled graph cycle exists, without enough feasibility
  evidence for a stronger statement.
- **Potentially feasible:** source and execution evidence support a plausible
  conflicting execution, with material uncertainties remaining.
- **Inconclusive:** missing, unresolved, or stale evidence prevents a
  defensible feasibility conclusion.
- **Rejected by feasibility checks:** a documented contradiction or proven
  modeled constraint rules out the scenario under its stated assumptions.
- **Independently confirmed:** independent evidence establishes a deadlock
  under clearly stated conditions.

None of these three archived cycles is independently confirmed. All are
classified **Inconclusive** because their only edge is uncertain, unrefined,
and uses an unresolved lock identity. A graph self-edge with an unknown lock
identity is not treated as proof of lock recursion or deadlock.

## Per-cycle findings

All cycles share the following archived facts:

- The reported path is a one-edge self-cycle. Its source and destination are
  the same unresolved lock key rooted at the irqsave acquisition in
  `drivers/net/ethernet/intel/e1000e/netdev.c:501:2`.
- That acquisition is `_raw_spin_lock_irqsave` in
  `e1000e_systim_to_hwtstamp`; the argument was rendered as
  `spinlock_check(&adapter->systim_lock)` and marked `unresolved`.
- The corresponding `spin_unlock_irqrestore(&adapter->systim_lock, flags)` is
  recorded in that function at `netdev.c:503`; its lock identity was rendered
  symbolically. The two identities were not unified by the archived run.
- The saved `flags` relation is unresolved. The edge IRQ-state field is
  `not_applicable`, not evidence that interrupts are enabled or disabled.
- The edge has `process` to `process` contexts, no handler, and no registration
  location. The translation unit has request_irq registrations, but those
  unrelated registrations do not establish a handler relation for this edge.
- No branch/path feasibility result is recorded: edge feasibility is
  `unrefined`. The archived uncertainty ledger associates five records with
  each finding: unavailable `spinlock_check` body, unresolved lock identity,
  unresolved irqsave flags, unknown IRQ effect, and unsupported API heuristic.

| Finding | Archived call path | Classification and basis |
| --- | --- | --- |
| C-1 | `e1000_clean_rx_irq:1032` → `e1000_receive_skb:558` → `e1000e_rx_hwtstamp:539` → `e1000e_systim_to_hwtstamp` (acquire at `501`, release at `503`) | **Inconclusive.** The call chain is present, but the alleged cycle is an uncertain self-edge over unresolved lock identity; IRQ state and feasibility are unrefined. |
| C-2 | `e1000_clean_rx_irq_ps:1457` → `e1000_receive_skb:558` → `e1000e_rx_hwtstamp:539` → `e1000e_systim_to_hwtstamp` (acquire at `501`, release at `503`) | **Inconclusive.** Same underlying lock site and uncertainty as C-1; this is a separate caller path, not independent evidence of a second lock order. |
| C-3 | `e1000_clean_jumbo_rx_irq:1637` → `e1000_receive_skb:558` → `e1000e_rx_hwtstamp:539` → `e1000e_systim_to_hwtstamp` (acquire at `501`, release at `503`) | **Inconclusive.** Same underlying lock site and uncertainty as C-1; this is a separate caller path, not independent evidence of a second lock order. |

The three reports therefore represent three propagation/call-path instances
of one problematic lock-identity site, not three independently validated
deadlocks. They are not rejected by a feasibility check: no such check was
recorded. Their likely self-edge artifact is evidence to investigate, not a
formal proof that no conflict exists.

## Required manual validation after restoring source

1. Rerun the pinned evaluation using the current analyzer and preserve new
   reports separately.
2. Inspect the macro expansion and verify acquisition and release both
   canonicalize to `adapter->systim_lock`.
3. Verify `flags` save/restore pairing and incoming IRQ-state semantics.
4. Inspect branch conditions and all lock operations on both paths in any new
   non-self cycle.
5. Establish actual handler registration/call-context evidence before
   labeling a candidate interrupt-aware.
6. Seek independent source review or other evidence before labeling any kernel
   issue independently confirmed.

The machine-readable JSON is the shared source for the website's historical
review panel; live analyzer reports continue to expose their own finding
category and linked uncertainty records.
