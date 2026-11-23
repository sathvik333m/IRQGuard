# Per-CPU lock identity model

IRQGuard recognizes exact `per_cpu(...)` and `this_cpu_ptr(...)` macro
expansions in lock expressions. It records a symbolic identity based on the
declared per-CPU storage object, the index when recoverable, and the selected
structure member. Macro expansion locations remain attached to the operation.

The currently supported index cases are:

- `this_cpu_ptr(&storage)` maps to `current_cpu`.
- `per_cpu(storage, smp_processor_id())` and a direct local index whose
  single supported assignment is `smp_processor_id()` map to `current_cpu`.
- A literal index maps to `constant(n)`, keeping distinct CPU instances apart.
- An unrecognized or mutable index is marked unresolved; it is not merged with
  `current_cpu` or another unresolved expression.

This is an expression identity abstraction, not proof that two operations run
on the same physical CPU or can overlap. The analyzer does not yet model all
preemption, CPU-hotplug callback, migration, or per-CPU pointer arithmetic
semantics. Function pointer aliases, opaque wrappers around per-CPU macros, and
more complex index computations may remain unresolved. A symbolic identity
must therefore be read as a reusable source-level identity template, not as a
runtime alias proof.

## qedi validation

The affected qedi source was analyzed at Linux commit
`8eebf0e84f0614cebc7347f7bbccba4056d77d42` using its generated Kbuild
compilation command (Clang 20.1.2). On that source,
`qedi_process_completions()` uses
`per_cpu(qedi_percpu, cpu)` after assigning `cpu = smp_processor_id()`, while
`qedi_cpu_offline()` uses `this_cpu_ptr(&qedi_percpu)`. Both operations now
produce the same symbolic `qedi_percpu[current_cpu].p_work_lock` identity.
The run extracted 98 functions and 24 API operations, with zero diagnostics,
zero lock dependencies, and zero interrupt cycles. It also reported 3,164
uncertainty events (971 structured uncertainty records). This change resolves
the lock-expression mismatch; it does not claim that IRQGuard detects the
historical qedi deadlock. The remaining call/context and dependency evidence
must be investigated separately. The run command was:

```sh
./build/deadlock-analyzer analyze \
  --source /tmp/irqguard-qedi-affected/drivers/scsi/qedi/qedi_main.c \
  --compile-commands /tmp/irqguard-qedi-build \
  --format json --output /tmp/qedi-after-final.json
```

The `/tmp` paths refer to the local pinned worktree and Kbuild output used for
this validation; they are not committed project inputs.

Run the focused fixture with:

```sh
ctest --test-dir build -R analyzer_percpu_identity --output-on-failure
```
