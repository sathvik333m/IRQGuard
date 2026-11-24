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

The supported abstraction is covered by a focused fixture. Run it with:

```sh
ctest --test-dir build -R analyzer_percpu_identity --output-on-failure
```
