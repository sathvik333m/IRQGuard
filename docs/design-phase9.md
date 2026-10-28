# Phase 9: Linux lock API extraction

## Scope and evidence

This change improves the existing Clang AST extractor and API model. It does not
add deadlock soundness claims or claim complete Linux support. The checked API
shape is based on the saved Linux v6.6.87 e1000e baseline plus the focused C
fixture `tests/fixtures/kernel_lock_api_macros.c`.

The preserved baseline report in `evaluation/baselines/phase9.0/BASELINE.md`
shows `_raw_spin_lock_irqsave` acquisition events at `netdev.c:501` and
`:3935`, followed by matching restore calls at `:503` and `:3938`. The defect
was semantic extraction rather than a missing AST event: the extracted lock
operand `spinlock_check(&adapter->systim_lock)` was marked unresolved and the
helper call did not carry the public macro's saved-flags lvalue. This prevented
the analyzer from matching lock identities and accurately transferring IRQ
state. Kernel source was unavailable for a fresh post-fix run, so post-fix
claims are limited to the focused fixture and the full local test suite.

## AST and macro handling

The extractor still uses Clang's `RecursiveASTVisitor` over `CallExpr` nodes.
For calls whose expression location is a macro ID, it asks Clang for the
expansion location and reads the token at that exact location. If that token is
a configured public API, the public semantic model is preferred when its
operation kind agrees with the expanded helper. This handles nested macros
without substring matching or broad preprocessor-branch enabling. Events with
the same configured API and expansion location are deduplicated, preferring the
AST node that carries the actual lock operand.

The lock operand unwraps the known identity-preserving `spinlock_check(x)`
wrapper before expression canonicalization. Other calls and arbitrary lock
expressions are not assumed to preserve identity; unresolved operands remain
marked unresolved and generate uncertainty evidence.

For Linux's return-flags helper shape, the saved state does not appear as an
argument to `_raw_spin_lock_irqsave(lock)`. The visitor walks the Clang parent
map and recovers the left side of an enclosing assignment only when that
assignment's right side is the helper call. The public macro token supplies the
state-argument model while the assignment AST supplies its lvalue. If the
assignment cannot be established, the state identity remains unresolved.
Source locations keep Clang's expansion and spelling coordinates separately;
reported macro API locations point to the source invocation.

## Built-in API semantics

The registry distinguishes lock acquisition/release, IRQ-changing lock pairs,
saved-state operations, and handler registration:

| API family | Extracted kind | Abstract state effect |
| --- | --- | --- |
| `mutex_lock`, `spin_lock`, selected raw aliases | `lock_acquire` | Acquire lock, IRQ state unchanged |
| `mutex_unlock`, `spin_unlock`, selected raw aliases | `lock_release` | Release lock, IRQ state unchanged |
| `spin_lock_irq`, selected raw aliases | `lock_acquire_irq` | Disable local IRQs before acquisition snapshot |
| `spin_unlock_irq`, selected raw aliases | `lock_release_irq` | Release and model the API's explicit local IRQ enable |
| `spin_lock_irqsave(lock, flags)`, selected raw/nested aliases | `lock_acquire_irqsave` | Save current abstract state to the flags identity, then disable IRQs |
| `spin_unlock_irqrestore(lock, flags)`, selected raw aliases | `lock_release_irqrestore` | Restore only the state associated with the matching flags identity |
| `local_irq_save(flags)` / `local_irq_restore(flags)` | `irq_save` / `irq_restore` | Save/restore abstract IRQ state by flags identity |
| `local_irq_disable` / `local_irq_enable` | `irq_disable` / `irq_enable` | Set IRQ state disabled/enabled |
| `request_irq` / `free_irq` | registration / unregistration | Registration retains resolvable handlers; teardown lifecycle remains uncertain |

`spin_unlock_irq` and `local_irq_enable` are modeled as explicit enable
operations according to their API contract. They are not aliases for
`irqrestore`; code that uses these APIs while already disabled may require
additional surrounding-state analysis and is not assumed equivalent to
`irqsave`/`irqrestore`.

Saved-state identities support ordinary lvalues and a single resolved pointer
wrapper pattern such as `*flags` in a helper called with `&flags`. The transfer
reduces this proven `*(&object)` pattern to that object's identity. Unresolved
pointer aliases, memory indirection, casts, volatile/atomic flag storage,
inline assembly, and arbitrary wrapper transformations stay conservative.
At a CFG join, differing saved states become unknown. A restore with no
matching state generates an explicit uncertainty; restoring is never modeled as
an unconditional enable.

Calls to locally defined wrappers are handled by existing interprocedural
summaries and are not mislabeled as unknown APIs solely because their names
contain `lock` or `irq`. Unresolved external calls with such names remain
reported as possibly unsupported. Calls such as `spinlock_check` inside this
fixture are ordinary resolved local calls, not lock events.

## Regression coverage

`tests/fixtures/kernel_lock_api_macros.c` models the observed nested macro
shape; it is not copied kernel source. `tests/test_kernel_lock_api_macros.py`
checks direct acquire/release classification, public macro naming, exact source
lines, one event per expansion, lock identity through `spinlock_check`, flags
identity, nested save/restore semantics, wrappers, separate flags, conditional
branches, explicit IRQ locks, local save/restore, and unresolved lock-return
expressions. Existing Phase 1–5 regression tests remain registered with CTest.

Reproduce with:

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure
build/deadlock-analyzer analyze \
  --source tests/fixtures/kernel_lock_api_macros.c --format json
```

To inspect operations and their locations from JSON:

```sh
build/deadlock-analyzer analyze \
  --source tests/fixtures/kernel_lock_api_macros.c --format json |
  jq '.api_operations[] | {api, kind, caller, lock, state_expression, state_identity, location}'
```

## Limitations

- This API list is a manually scoped model, not a generated inventory of all
  locking APIs in a given kernel revision.
- The macro regression fixture tests an expansion shape but does not replace a
  fresh build-configured run against the kernel headers.
- Public macro recognition depends on the expansion-site token being available
  to Clang. Alternative compiler flags or macro indirection can change the AST
  shape; unresolved cases must remain visible.
- `spinlock_check` is unwrapped only as an identity-preserving lock operand
  wrapper. The analyzer does not implement arbitrary pointer alias analysis.
- This phase does not validate generated Kbuild flags, compile the kernel, or
  revisit the saved objtool/libelf validation skips. It makes no claim that the
  complete kernel is supported.
