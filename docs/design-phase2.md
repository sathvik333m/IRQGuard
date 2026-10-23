# Phase 2 design: call graph and interprocedural lock summaries

## Extraction additions

The Phase 1 AST visitor now assigns each in-file function a source-derived ID, builds its Clang CFG, and associates call sites with CFG blocks. Each call records direct/indirect resolution, candidate target IDs, symbolic actual-argument identities, and whether the call is a modeled API operation. API lock events retain the same symbolic identity template. The original function, call, lock-operation, control-construct, macro, and source-location fields remain in the JSON output.

The call graph has nodes for analyzed definitions and for external or unresolved targets. Direct calls to in-file definitions become internal edges. Calls to declarations without analyzed bodies become external edges. The supported indirect pattern is a function-pointer variable initialized or assigned directly from a function address. Assignments are collected across the translation unit and candidate targets are unioned; fields, opaque casts, callback registries, points-to propagation through arbitrary expressions, and function-pointer parameters without known assignments remain unresolved.

## Lock identity

Identities are structural symbolic expressions, not variable-name strings. A reference to a formal parameter becomes `@param[n]`; references to declarations include source location and qualified name; automatic local declarations are additionally scoped to a bounded call-site activation chain. Members, array subscripts, unary operations, binary operations, and conditional expressions recursively encode their operands. At a call, formal placeholders are substituted with the caller's symbolic actual arguments.

This distinguishes different local declarations with similar names and keeps function-relative parameters scoped through their summary. When summaries are projected into the interrupt graph, formal placeholders are additionally namespaced by the reporting function so unrelated `@param[n]` identities cannot create cross-function cycles. It is not points-to analysis. Two distinct expressions that may alias remain separate; unsupported expressions receive location-specific unresolved identities. When unresolved facts cross a call boundary, the call site is included in the identity to avoid treating separate call sites as definitely the same lock. Reports mark those identities uncertain.

## Summary domain and CFG transfer

Each function summary contains acquisitions observed anywhere in that function or its callees, release events, may-held acquisitions at return, lock identities released on every return path, dependencies, and uncertainty records. A dependency records the source and target acquisition locations, the function that reports it, the function where its target acquisition originated, whether it is direct or inferred through calls, and the call chain.

Clang CFG blocks carry ordered call events. The forward worklist tracks a union of possibly held acquisition facts and an intersection of locks definitely released on all paths reaching a block. Acquiring a lock adds dependencies from each possibly held lock to the acquired lock. Releasing a lock removes matching held facts. At a call, summaries are instantiated at the call site: held caller locks are paired with callee acquisitions; callee dependencies are propagated; and the callee's return effects update the caller state. For indirect calls with multiple candidates, acquisitions are unioned and releases are intersected. An unknown/external target contributes no assumed release and produces an explicit uncertainty; it does not erase the caller's held state.

All function summaries are recomputed to a fixed point so direct recursion and mutual recursion propagate. The analysis uses bounded call-chain provenance (four call sites) and substitutes identities up to 512 characters; overflow creates an unresolved call-site identity. The CFG worklist also has a per-function iteration limit. A failure to converge is reported in summary uncertainty rather than silently accepted.

## Precision and limits

- Branches in the CFG are both considered possible. The analysis does not solve predicates, prove branch infeasibility, or model exceptions/signals.
- May-held union avoids enumerating path combinations but can combine locks from distinct paths at joins and report extra possible orders.
- C expression evaluation order is not fully modeled. Calls in a single expression are ordered by source end location; C's unspecified operand evaluation order can therefore hide an alternative order.
- Lock identity is syntactic and declaration-based. Pointer aliases, heap object identity, array index ranges, casts, and lock copies are not resolved. Different symbolic identities are not merged merely because their names are similar.
- Function-pointer resolution supports direct initializers and assignments to variables, with a translation-unit-wide target union. It can include infeasible candidates. Unsupported indirect calls and external bodies are reported as uncertainties.
- Calls made while a lock is held and resolved only to an external/unavailable body are explicitly noted; no hidden lock behavior is invented.
- This phase reports possible lock-order dependencies. It does not build an interrupt-aware graph, validate a deadlock cycle, or claim a deadlock.
