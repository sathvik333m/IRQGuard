# Phase 5: Controlled userspace runtime lock evidence

## Scope and relationship to Archerfish

This optional harness exercises ordinary userspace `pthread_mutex_t` objects.
It is a validation aid for controlled C/C++ fixtures, not an extension of the
Clang kernel analyzer's execution model. It does not emulate hard interrupts,
Linux IRQ disabling, preemption, kernel spinlocks, or hardware delivery.

The paper describes an interrupt-aware lock graph and cycle refinement. This
phase adopts only the general practices of retaining event provenance and
separating a graph cycle from evidence that a particular execution reached a
stalled state. The harness does not implement the paper's interrupt-aware lock
graph, handler analysis, or kernel feasibility analysis, and is not equivalent
to Archerfish. See the [USENIX Security 2024 paper](https://www.usenix.org/system/files/usenixsecurity24-ye.pdf).

## Instrumentation and trace schema

`irqguard_lock` and `irqguard_unlock` wrap `pthread_mutex_t`. The lock wrapper
records one `acquire_attempt`, then uses `pthread_mutex_trylock` with
`sched_yield` until it succeeds. On the first `EBUSY`, it records
`contention_observed`. This means a mutex was held at that observation; it does
not claim the thread entered a kernel blocking wait. Successful acquisitions
and releases are recorded as well. Releases and ownership transfers are
serialized through the event logger to keep the trace ordering coherent.

Each JSONL row contains schema version, run ID, monotonically increasing event
sequence, monotonic timestamp in nanoseconds, process ID, Linux thread ID, the
caller-provided runtime lock identity, and event type. `IRQGUARD_TRACE` is
required. Every row is flushed so the watchdog can inspect the trace after
terminating a stuck fixture. Logging and polling add scheduling and runtime
overhead.

The processor derives per-thread lock-order observations from successful
acquisitions while other tracked locks remain held. It reconstructs wait-for
edges only from observed contention plus current owners. It analyzes one trace
run at a time: opposite edge directions from separate processes are never
combined into a wait-for cycle. The `opposite-order` scenario deliberately
observes both directions sequentially and must not be called a deadlock.

## Watchdog and interpretation

The `deadlock` scenario synchronizes two threads after they acquire opposite
locks, then has each request the other's lock. `runtime_evidence.py run` starts
the executable in a separate process group. At the timeout it kills that group,
then summarizes the flushed trace. A report uses
`watchdog_timeout_with_persistent_wait_for_cycle` only when the run timed out
and a wait-for cycle was still present in the final trace. This demonstrates
the controlled fixture reached and retained the constructed cycle through the
configured bound. It is not proof that an arbitrary program would deadlock or
that a longer timeout is impossible to recover from.

Runtime order presence is not a deadlock finding. Conversely, a candidate that
the selected runtime run does not exercise is labeled
`not_observed_not_disproven`; runtime absence is not evidence of safety.
Interrupt-aware findings are marked not comparable to a userspace trace.

## Static/runtime identity mapping

The analyzer uses declaration-aware identities; the runtime tracer uses labels
such as `A` and `B`. Comparison requires an explicit `static_to_runtime` map
whose keys are exact analyzer lock identity strings from
`api_operations[*].lock.identity_template`. It does not merge locks by similar
names or infer aliasing. The example integration test derives this mapping from
the fixture's exact source expressions, and verifies the unused C/D candidate
remains not observed rather than disproven.

## Controlled programs and overhead

`runtime/fixtures/lock_orders.c` supplies the lock operations parsed by the
static analyzer. The linked C++ demo supports these independent scenarios:

| Scenario | Expected evidence |
| --- | --- |
| `safe` | One balanced A→B order; no contention or wait cycle. |
| `reverse-only` | One balanced B→A order, in its own process invocation. |
| `opposite-order` | Sequential A→B and B→A order observations; no wait cycle. |
| `contention` | Two threads share the same order; at least one `EBUSY` contention observation; no cycle. |
| `deadlock` | Opposite locks held concurrently, a persistent wait-for cycle, then watchdog termination. |
| `static-only` | Executes A→B while static C/D candidates remain unexercised. |

The benchmark compares the same mutex-pair loop using direct pthread calls and
instrumented wrappers. It alternates sample order, reports each in-process
elapsed time, computes medians, and calculates `(instrumented_median /
baseline_median - 1) * 100`. The result describes only that machine and run; it
is not a portable performance claim. Trace writes are flushed per event, so
this measurement includes serialization, logger synchronization, and flush
cost. The recorded sample in
[`examples/runtime-overhead-report.json`](../examples/runtime-overhead-report.json)
measured a 70,995.86% median increase for 1,000 lock-pair iterations over five
repeats on WSL2 x86_64. This very high figure reflects per-event JSON writing
and flushing; use it as an instrument overhead warning for this implementation,
not as a general estimate for other workloads or machines.

## Reproduction

Build and run the controlled scenarios:

```sh
cmake --build build
python3 runtime/runtime_evidence.py run --program build/irqguard-runtime-demo \
  --scenario safe --trace /tmp/irqguard-safe.jsonl
python3 runtime/runtime_evidence.py run --program build/irqguard-runtime-demo \
  --scenario opposite-order --trace /tmp/irqguard-orders.jsonl
python3 runtime/runtime_evidence.py run --program build/irqguard-runtime-demo \
  --scenario contention --trace /tmp/irqguard-contention.jsonl
python3 runtime/runtime_evidence.py run --program build/irqguard-runtime-demo \
  --scenario deadlock --timeout 1.5 --trace /tmp/irqguard-deadlock.jsonl
```

Produce the static report and benchmark separately:

```sh
build/deadlock-analyzer analyze --source runtime/fixtures/lock_orders.c \
  --api-config runtime/apis.json --clang-arg -Iruntime --format json \
  --output /tmp/irqguard-static.json
python3 runtime/runtime_evidence.py benchmark \
  --program build/irqguard-runtime-demo --iterations 1000 --repeats 5 \
  --output /tmp/irqguard-overhead.json
ctest --test-dir build --output-on-failure
```

For comparison, copy exact `identity_template` values from the static report
into a map file:

```json
{
  "static_to_runtime": {
    "<exact identity for runtime_lock_a>": "A",
    "<exact identity for runtime_lock_b>": "B",
    "<exact identity for static_only_lock_c>": "C",
    "<exact identity for static_only_lock_d>": "D"
  }
}
```

Pass each run's `.summary.json` separately to the comparison command:

```sh
python3 runtime/runtime_evidence.py compare \
  --static-report /tmp/irqguard-static.json \
  --lock-map /tmp/irqguard-lock-map.json \
  --summary /tmp/irqguard-safe.jsonl.summary.json \
  --output /tmp/irqguard-comparison.json
```

## Limitations

- This harness is Linux userspace only and uses pthread mutexes. It does not
  load modules, change IRQ state, access hardware interrupts, or validate the
  kernel interrupt model.
- `contention_observed` means `trylock` returned `EBUSY`; the implementation
  polls rather than observing a portable OS-level blocked state.
- The timeout is an experiment bound, not a proof of permanent non-progress.
- Measurements depend on CPU scheduling, system load, and trace storage.
- Exact static/runtime identity mapping is user supplied; aliases are not
  inferred.
- This is a controlled fixture harness, not a transparent instrumenter for
  arbitrary pthread programs. Code must use the provided wrappers to appear in
  traces.
