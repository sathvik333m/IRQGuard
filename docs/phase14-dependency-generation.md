# Phase 14 — Lock dependency generation validation

## Result

The zero dependency count in the saved latest Linux v6.6.87 run is consistent
with a corrected lock identity; it is not evidence that the analyzer stopped
generating dependencies in general. The earlier six reported dependencies were
all self-edges whose source and target acquisition pointed to the same
`spin_lock_irqsave` invocation. They produced three one-edge self-cycle
reports. The available reports do not establish a real nested lock order in
those cases.

The baseline report at `evaluation/baselines/phase9.0/kernel-v6.6.87-raw-reports.tar.gz`
shows the mechanism. For the `netdev.c:501` and `:3935` acquisitions, the
acquisition identity was `unknown@<source location>`, while the corresponding
`spin_unlock_irqrestore` at lines 503 and 3938 had a symbolic identity such as
`unary(&,member(@param[0]->e1000_adapter::systim_lock))`. In
`src/Interprocedural.cpp`, release transfer removes a held acquisition only
when the lock identity strings match. The mismatch left the acquisition in
the may-held state, allowing repeated helper/loop call paths to emit same-site
self-edges.

The saved Phase 13 rerun has the same six acquisitions and six releases across
the five selected files, but each irqsave acquisition now has the same
symbolic lock identity as its matching irqrestore. Its reports contain zero
dependencies, edges, or cycles. This is the expected outcome for those
previous self-edges after identity matching; it does not prove that the driver
or kernel is free of deadlocks. The source checkout used by that saved run is
not currently available, so these Phase 14 counts are an inspection of saved
artifacts, not a fresh kernel rerun.

## Pipeline traced

The current flow is:

1. `src/Analyzer.cpp` visits Clang call AST nodes, resolves configured API
   operations and constructs symbolic identities for lock expressions.
   Macro-aware extraction records the public `spin_lock_irqsave` invocation
   and unwraps the kernel-style `spinlock_check` expression.
2. `AnalysisResult::apiOperations` carries the operation kind, lock identity,
   source location, caller, and saved IRQ-state identity.
3. `src/Interprocedural.cpp::analyzeInterprocedural` builds call-graph edges
   and computes function summaries to a fixed point.
4. `summarizeFunction` runs a CFG worklist. An acquisition adds edges from
   possibly held facts; a matching release removes held facts. Calls instantiate
   available summaries and preserve call-site provenance.
5. `src/InterruptAnalysis.cpp` projects dependency facts into context-labelled
   graph edges, performs feasibility refinement, and reconstructs cycle
   candidates.
6. `src/Output.cpp` serializes dependencies, graph edges, provenance, and
   findings into JSON and terminal output.

The dependency convention is **earlier-held lock → newly acquired lock**.
Identities are structural symbolic expressions. The analysis is a bounded,
may-held abstraction: branch joins can conservatively combine locks from
different paths; dependency edges are not proof that a deadlock execution is
feasible.

## Phase 14 regression coverage

`tests/fixtures/dependency_generation.c` and
`tests/test_dependency_generation.py` check:

- Direct `A → B` and reversed `B → A` dependencies, with source locations.
- No edge for independent lock pairs or releases before the next acquisition.
- No edge for mutually exclusive branches that each release their lock.
- A dependency instantiated through a known helper summary and its call-site
  provenance.
- An unresolved lock expression remains explicitly `unresolved_identity`.
- An unavailable external body adds uncertainty without inventing a lock
  dependency.

The existing `analyzer_kernel_lock_api_macros` test also checks equality of the
symbolic identities for macro-expanded irqsave/irqrestore operations and
preserves flags identities. No new lock-cycle or deadlock claim is added.

## Reproduction and actual results

Commands run for this phase:

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure -R analyzer_dependency_generation
ctest --test-dir build --output-on-failure
```

Results: the focused dependency-generation test passed. The complete suite
passed **15/15** tests after adding the new regression test. Phase 14 did not
run a fresh kernel analysis because its expected `/tmp/linux-v6.6.87` path was
not found. A later search located the pinned checkout under `/home/sathvik/`;
therefore the old path check must not be read as proof that the source tree was
absent from the machine. The Phase 15 rerun is documented below.

To repeat the kernel analysis with the in-project checkout:

```sh
python3 evaluation/run_kernel_eval.py \
  --kernel third_party/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87/phase15-rerun --jobs 2
```

The runner checks the pinned commit and writes reports to the specified output
directory. Review the resulting `raw-measurements.json` and per-file reports;
do not interpret a zero edge count as proof of absence of bugs.

**Follow-up:** `/home/sathvik/linux-v6.6.87` was found and moved into the
repository's ignored `third_party/linux-v6.6.87/` directory. The fresh Phase 15
run is documented in
[`phase15-report.md`](../evaluation/results/linux-v6.6.87/phase15-report.md).

## Files changed and limitations

This phase adds a focused fixture/test and connects the test to CTest. It does
not modify the analyzer algorithm because the controlled positive and negative
cases pass, while the saved kernel edge loss is explained by the earlier
unresolved-acquire versus symbolic-release mismatch. This preserves the
corrected identity behavior instead of restoring unsupported self-edges.

Limitations remain: the kernel analysis is per translation unit; unresolved
aliases, missing bodies, macro configurations and unsupported APIs remain
uncertain; CFG path feasibility is bounded; and no independent ground-truth
label set supports precision/recall. A kernel rerun is still needed to verify
current counts directly from the pinned source tree.
