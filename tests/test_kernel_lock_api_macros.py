#!/usr/bin/env python3
"""Regression tests for Linux-style macro-expanded lock extraction."""
import json
import subprocess
import sys

binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)
ops = report["api_operations"]

# Direct calls distinguish acquisitions/releases, retain source locations, and
# do not claim saved IRQ state for APIs that have no such argument.
direct = [o for o in ops if o["caller"] == "direct_mutex_operations"]
assert [(o["api"], o["kind"]) for o in direct] == [
    ("mutex_lock", "lock_acquire"), ("mutex_unlock", "lock_release")]
assert [o["location"]["expansion"]["line"] for o in direct] == [34, 35]
assert all(o["location"]["expansion"]["file"].endswith("kernel_lock_api_macros.c")
           for o in direct)
assert all(o["state_identity_status"] == "not_applicable" for o in direct)

# Nested macro expansion yields one operation for each public operation. It
# retains the public API names, lock operands, source lines, and distinct flags.
nested = [o for o in ops if o["caller"] == "nested_macro_lock_operations"]
macro_ops = [o for o in nested if o["api"].startswith("spin_") and "irq" in o["api"]]
assert [(o["api"], o["location"]["expansion"]["line"]) for o in macro_ops] == [
    ("spin_lock_irqsave", 40), ("spin_lock_irqsave", 41),
    ("spin_unlock_irqrestore", 42), ("spin_unlock_irqrestore", 43)]
assert all(o["lock"]["identity_status"] == "symbolic" for o in macro_ops)
assert all(o["location"]["is_macro"] and
           o["location"]["expansion"]["line"] in {40, 41, 42, 43} and
           o["location"]["spelling"]["valid"] for o in macro_ops)
by_api_line = {(o["api"], o["location"]["expansion"]["line"]): o for o in macro_ops}
assert by_api_line[("spin_lock_irqsave", 40)]["lock"]["identity_template"] == \
       by_api_line[("spin_unlock_irqrestore", 43)]["lock"]["identity_template"]
assert by_api_line[("spin_lock_irqsave", 40)]["state_identity"] == \
       by_api_line[("spin_unlock_irqrestore", 43)]["state_identity"]
assert by_api_line[("spin_lock_irqsave", 41)]["state_identity"] != \
       by_api_line[("spin_lock_irqsave", 40)]["state_identity"]
assert not any(o["api"] in {"_raw_spin_lock_irqsave", "raw_spin_lock_irqsave",
                              "spinlock_check"} for o in nested)

# The snapshot is taken after irqsave disables local IRQs. Inner restore keeps
# IRQs disabled; only the matching outer restore returns to enabled.
def snapshots(function, needle):
    return [s for s in report["interrupt_state_snapshots"]
            if s["source_function"] == function and needle in s["lock_identity"]]
assert [s["irq_state"] for s in snapshots("nested_macro_lock_operations", "lock_a")
        if s["location"]["expansion"]["line"] == 40] == ["disabled"]
assert all(s["irq_state"] == "disabled" for s in snapshots("nested_macro_lock_operations", "lock_b"))

# Source-level wrappers are resolved and retain the lock/flags relationship.
for name in ("save_lock_wrapper", "restore_lock_wrapper"):
    wrapper_ops = [o for o in ops if o["caller"] == name]
    assert len(wrapper_ops) == 1, (name, wrapper_ops)
    assert wrapper_ops[0]["lock"]["identity_status"] == "symbolic"
    assert wrapper_ops[0]["state_identity_status"] == "symbolic"
assert snapshots("wrapped_macro_lock_operations", "lock_b")
assert [s["irq_state"] for s in snapshots("wrapped_macro_lock_operations", "lock_c")
        if s["location"]["expansion"]["line"] == 62] == ["enabled"]

# Independent flag objects are not conflated. A branch-dependent saved state
# yields an uncertainty; an arbitrary lock-return expression remains unresolved.
separate = [o for o in ops if o["caller"] == "separate_flags_variables"
            and o["api"] == "spin_lock_irqsave"]
assert len(separate) == 2 and separate[0]["state_identity"] != separate[1]["state_identity"]
assert any("irqrestore has no matching saved state" in u
           for u in report["uncertainties"])
assert any(s["irq_state"] == "unknown"
           for s in snapshots("conditional_macro_operations", "lock_b"))
unknown = [o for o in ops if o["caller"] == "unresolved_macro_lock_expression"
           and o["api"] == "spin_lock_irqsave"]
assert len(unknown) == 1 and unknown[0]["lock"]["identity_status"] == "unresolved"
assert unknown[0]["state_identity_status"] == "symbolic"
assert any("unresolved_macro_lock_expression" in u and "lock identity unresolved" in u
           for u in report["uncertainties"])
assert any("possibly unsupported lock/IRQ API 'spin_lock_bh'" in u
           for u in report["uncertainties"])

# Explicit IRQ and local save/restore APIs have separate semantic kinds.
irq_ops = [o for o in ops if o["caller"] == "explicit_irq_lock_operations"]
assert [o["kind"] for o in irq_ops] == ["lock_acquire_irq", "lock_release_irq"]
local = [o for o in ops if o["caller"] == "local_irq_save_restore_operations"]
assert [(o["api"], o["kind"]) for o in local[:2]] == [
    ("local_irq_save", "irq_save"), ("spin_lock", "lock_acquire")]
assert local[0]["state_identity_status"] == "symbolic"
assert all(s["irq_state"] == "disabled"
           for s in snapshots("local_irq_save_restore_operations", "local_lock_a"))
assert all(s["irq_state"] == "enabled"
           for s in snapshots("local_irq_save_restore_operations", "local_lock_b"))

# A semantic event is attached to each source invocation exactly once; helper
# validators and local wrappers do not create duplicate uncertainty warnings.
assert len([o for o in ops if o["caller"] == "nested_macro_lock_operations"
            and o["api"] == "spin_lock_irqsave"]) == 2
assert not any("possibly unsupported lock/IRQ API 'spinlock_check'" in u
               for u in report["uncertainties"])
assert not any("possibly unsupported lock/IRQ API 'save_lock_wrapper'" in u
               for u in report["uncertainties"])
print("all kernel lock API macro tests passed")
