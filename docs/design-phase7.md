# Phase 7: integrated CLI, reports, and reproducibility

## Architecture

The C++17 `deadlock-analyzer` remains the analysis engine. Clang LibTooling
builds AST and CFG facts; the Phase 2 summary engine propagates lock effects
through resolved calls; the interrupt model identifies supported registrations
and state transitions; cycle discovery and bounded feasibility refinement
produce explainable findings. Schema-v3 JSON is the shared static report
contract. The optional `irqguard` Python 3 entry point is an orchestration
layer: it invokes the existing analyzer and the separately scoped Phase 5/6
tools with argument arrays and `shell=False`. It does not reimplement static
analysis or alter reports.

```text
source + compile flags + API registry
                  │
                  ▼
        Clang AST / CFG extraction
                  │
                  ▼
      interprocedural lock summaries
                  │
                  ▼
   IRQ state + process/hardirq graph
                  │
                  ▼
   bounded cycle / feasibility analysis
                  │
          ┌───────┴─────────┐
          ▼                 ▼
     text / JSON / DOT   runtime comparison
                            │
                    controlled userspace only
```

## CLI

From the repository root after building:

```sh
./irqguard --help
./irqguard analyze --source examples/basic.c
./irqguard analyze --source examples/basic.c --format json --output /tmp/basic.json
./irqguard graph --source tests/fixtures/interrupts.c --output /tmp/interrupts.dot
./irqguard analyze --source file.c --compile-commands build
./irqguard analyze --source file.c --api-config config/apis.example.json
./irqguard analyze --source file.c --clang-arg=-Iinclude --clang-arg=-DCONFIG_X=1
./irqguard api-registry validate --config config/apis.example.json
```

`analyze --format json` exports the entire report, including findings and
provenance. `graph` uses the same source, registry, and compilation options,
then writes the analyzer's Graphviz DOT graph. The existing
`build/deadlock-analyzer analyze ...` interface remains available for scripts
that use the C++ executable directly.

Controlled runtime evidence and static/runtime comparison are exposed through
the same top-level command:

```sh
./irqguard runtime run --scenario safe --trace /tmp/safe.jsonl
./irqguard runtime run --scenario deadlock --timeout 1.5 --trace /tmp/deadlock.jsonl
./irqguard runtime summarize --trace /tmp/safe.jsonl --termination completed
./irqguard compare --static-report /tmp/static.json --lock-map /tmp/map.json \
  --trace /tmp/safe.jsonl --termination completed --output /tmp/comparison.json
./irqguard benchmark runtime --iterations 1000 --repeats 5 \
  --output /tmp/runtime-overhead.json
```

Comparison requires an explicit map from exact static lock identity strings to
the harness's runtime lock IDs. A missing observation is
`not_observed_not_disproven`; separate runs are not combined to claim a
deadlock. `benchmark runtime` measures only the controlled pthread wrapper
loop. The reproducible kernel command requires a clean checkout of the pinned
revision and retains the Phase 6 limitation that objtool validation is skipped
in this environment:

```sh
./irqguard benchmark kernel --kernel /tmp/linux-v6.6.87 \
  --output evaluation/results/linux-v6.6.87
```

The full source-evaluation protocol and current raw data are in
[`design-phase6.md`](design-phase6.md) and
[`evaluation/results/linux-v6.6.87/REPORT.md`](../evaluation/results/linux-v6.6.87/REPORT.md).

## API registry configuration

Registry files are JSON objects with an `apis` array. Each entry has a
non-empty `name` and `kind`, and may provide zero-based `lock_argument`,
`state_argument`, and `handler_argument` indexes from 0 through 1024. A custom
entry with a built-in name replaces that built-in by name; other entries extend
the registry. The API kind controls the model and must match the analyzer's
understood event kinds for lock or IRQ behavior. Unknown kinds are extracted as
API facts but do not gain lock/IRQ semantics automatically. Validation checks
the registry shape and index bounds; use it on every edited registry before
analysis.

## Report contract and finding semantics

Schema version 4 is the current report format; the web adapter continues to
read schema-v3 historical reports. The top-level
fields are `schema_version`, `source`, `analysis_kind`, `functions`, `calls`,
`api_operations`, `control_constructs`, `call_graph`, `function_summaries`,
`lock_dependencies`, `interrupt_registrations`, `interrupt_state_snapshots`,
`interrupt_lock_graph`, `interrupt_cycles`, `uncertainties`,
`uncertainty_summary`, `uncertainty_records`, and `diagnostics`.
Locations retain macro expansion and spelling points when available.
Dependencies and interrupt graph edges preserve functions, acquisition
locations, execution contexts, registration sites, and call-chain provenance.
Every cycle finding has a lock sequence, edge sequence, source evidence, and an
explanation/category; parser and resolution limits are surfaced separately.

The implementation deliberately has no numeric risk/severity score. Categories
mean:

| Category | Interpretation |
| --- | --- |
| `candidate_lock_order_cycle` | A process-context lock-order cycle with no known contradictory IRQ fact. |
| `interrupt_aware_candidate` | A candidate cycle relying on modeled process-to-hardirq preemption. |
| `rejected_candidate` | A counterfactual interrupt-cycle shape rejected by the modeled definitely-disabled local hard IRQ state. It is not an executable graph cycle. |
| `inconclusive_analysis` | A cycle path uses a state/edge whose feasibility is uncertain. |

These are static analysis classifications, not confirmed deadlocks. No report
field claims that a kernel bug has been validated. The refreshed Phase 6 e1000e
selection has three inconclusive cycle reports involving unresolved lock
identities. Its macro-expanded irqsave acquisitions are now extracted, but
lock identities and saved-flags state remain unknown. These findings are not
validated bugs and cannot establish whether the driver is deadlock-free.

## Demonstration on ordinary source

`examples/basic.c` is ordinary C source, parsed without markers. It contains
`worker`, which acquires `outer` and calls `update_state`, which acquires
`lock`. Running:

```sh
./irqguard analyze --source examples/basic.c --format text
./irqguard analyze --source examples/basic.c --format json --output /tmp/basic.json
```

extracts both definitions, the call site and lock operations, and reports the
inferred `@param[0] -> @param[1]` dependency in `worker`, with original source
locations. This is a lock-order dependency, not a cycle or deadlock finding.
The runtime integration test also analyzes the controlled C fixture, executes
its linked pthread harness and compares a trace against the resulting static
report using exact lock identity mappings.

## Research relationship and design decisions

The project is independently developed and is not a reproduction of
Archerfish. The paper introduces an Interrupt-Aware Lock Graph, recognizes
interrupt handlers from modeled/generated specifications, computes lockset
and IRQ state, groups critical sections into preemption units, discovers
cycles, and lazily validates interrupt and path feasibility. This project
adopts the high-level ideas of context-labelled regular/interrupt lock edges,
interprocedural summaries, explicit IRQ-state tracking, cycle reconstruction,
and refinement. The implementation uses Clang AST/CFG facts and bounded
in-file call summaries; it models a small manually configured API subset and
only resolvable `request_irq` targets. It does not generate ISR specifications
with an LLM, identify broad callback-registration families, implement the
paper's preemption-unit analysis, perform the same lazy validation algorithm,
or analyze Linux at whole-tree scale. Its path reasoning is modest CFG
reachability and state propagation, not full path-condition solving. Runtime
instrumentation is a separate controlled userspace extension and is not part
of Archerfish's static method.

The paper's methodology and scope are described in Ye, Cai, and Zhang,
“When Threads Meet Interrupts: Effective Static Detection of Interrupt-Based
Deadlocks in the Linux Kernel,” USENIX Security 2024, especially §§3–4:
[USENIX paper PDF](https://www.usenix.org/system/files/usenixsecurity24-ye.pdf).

## Validation, performance, and reproducibility

The current CTest suite contains eight tests: extraction, interprocedural
summaries, IRQ modeling, feasibility refinement, review regressions, evaluation
summarization, runtime evidence, and unified CLI integration. Frontend checks are separate:
`cd web && npm test && npm run build`.

Recorded measurements are machine- and scope-specific:

- The Linux v6.6.87 e1000e evaluation analyzed five selected files: 396
  function definitions, 12 lock operations, 6 dependencies, 3 inconclusive
  cycle reports, 43,705 uncertainty entries and two CFG diagnostics; elapsed
  analyzer time summed to 6.644 seconds and maximum per-process peak RSS was
  192,312 KiB. The
  complete per-file measurements and configuration hash are recorded in
  `evaluation/results/linux-v6.6.87/raw-measurements.json`.
- The controlled interrupt fixture's recorded analysis and `/usr/bin/time -v`
  data are under `evaluation/results/controlled-interrupt-fixture/`.
- Runtime instrumentation overhead has one separately documented WSL2 sample
  in `examples/runtime-overhead-report.json`. The measured overhead is specific
  to that flush-heavy implementation and machine.

The kernel scope has no independently labeled kernel ground truth; precision,
recall, and counts of validated bugs are therefore unavailable. The selected
kernel object build skipped objtool validation due to missing host dependencies.
See the reports before interpreting any performance or finding count.

## Dependencies and safety boundaries

The C++ analyzer requires CMake, a C++17 compiler, and matching LLVM/Clang
development libraries. Python 3 drives CTest, runtime trace processing, CLI
orchestration, and the evaluation runner. Linux userspace runtime scenarios
need pthreads and the compiled `irqguard-runtime-demo`. The optional web
interface also needs Node.js 20+ and npm. Installation commands for Ubuntu 24.04
on WSL 2 are in the root README.

The CLI parses source but does not execute it. Compilation-database flags may
cause Clang to read project headers and local compiler inputs; only analyze
trusted source trees. The runtime wrapper intentionally executes only the
project's allowlisted demo scenarios in a separate bounded process group. The
kernel evaluation builds selected objects but never boots a kernel, loads a
module, or changes hardware/host IRQ settings. Kernel-level experiments require
a disposable VM and are outside this project's automated workflow.

## Explicit unsupported scope

- One translation unit per static analyzer invocation; included header bodies
  and cross-TU whole-program summaries are not generally available.
- Partial API coverage, aliases, arbitrary function-pointer targets, many
  callback-based ISR APIs, softirq/NMI contexts, and registration lifetime.
- No full path predicates/SMT, whole-kernel scheduling model, or formal
  soundness/completeness guarantee.
- Runtime evidence only covers programs using the provided pthread wrappers;
  it cannot exercise hard IRQs or validate kernel candidates.
- No confirmed Linux bug count, precision/recall, or whole-kernel performance
  claim.
