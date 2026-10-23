#!/usr/bin/env python3
import json
import subprocess
import sys

binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)

# Public lock APIs invoked through function-like macros are retained at their
# expansion locations, even though the AST callee is an implementation helper.
macro_ops = [op for op in report["api_operations"]
             if op["caller"] == "macro_lock_pair"]
assert {op["api"] for op in macro_ops} >= {
    "spin_lock_irqsave", "spin_unlock_irqrestore"
}, macro_ops
assert all(op["location"]["is_macro"] and
           op["location"]["expansion"]["valid"] for op in macro_ops)
raw_helpers = [op for op in report["api_operations"]
               if op["caller"] == "raw_kernel_helpers"]
assert {op["api"] for op in raw_helpers} >= {
    "_raw_spin_lock_irqsave", "_raw_spin_unlock_irqrestore"
}, raw_helpers

# Independent formal parameters from separate functions do not form a cycle.
cross_function_cycles = [cycle for cycle in report["interrupt_cycles"]
                         if any("order_ab#" in lock for lock in cycle["lock_sequence"])
                         and any("order_ba#" in lock for lock in cycle["lock_sequence"])]
assert not cross_function_cycles, cross_function_cycles

# Reacquiring one non-recursive lock is represented as a one-edge cycle.
self_cycles = [cycle for cycle in report["interrupt_cycles"]
               if cycle["category"] == "candidate_lock_order_cycle"
               and len(cycle["lock_sequence"]) == 2
               and cycle["lock_sequence"][0] == cycle["lock_sequence"][1]
               and "reacquire_same#" in cycle["lock_sequence"][0]]
assert self_cycles, report["interrupt_cycles"]

# An unknown indirect target must keep the post-call IRQ state unknown even
# when a known candidate has a definite local_irq_disable effect.
unknown_snapshots = [snapshot for snapshot in report["interrupt_state_snapshots"]
                     if snapshot["source_function"] == "unknown_indirect_target"
                     and "process_lock" in snapshot["lock_identity"]]
assert unknown_snapshots and all(snapshot["irq_state"] == "unknown"
                                 for snapshot in unknown_snapshots)
assert any("unmodeled call may alter IRQ state" in item
           and "unknown_indirect_target" in item for item in report["uncertainties"])

print("all review-fix regression tests passed")
