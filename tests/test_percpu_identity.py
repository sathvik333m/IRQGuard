#!/usr/bin/env python3
"""Regression tests for conservative per-CPU lock identities."""
import json
import subprocess
import sys

binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)
operations = report["api_operations"]


def lock_ops(function):
    return [op for op in operations if op["caller"] == function]


same_cpu = lock_ops("this_cpu_ptr_current_cpu_alias")
assert [op["api"] for op in same_cpu] == ["spin_lock_bh", "spin_unlock"]
assert all(op["lock"]["identity_status"] == "symbolic" for op in same_cpu)
assert same_cpu[0]["lock"]["identity_template"] == same_cpu[1]["lock"]["identity_template"]
assert "qedi_percpu,current_cpu" in same_cpu[0]["lock"]["identity_template"]
explicit_cpu = lock_ops("explicit_current_cpu_instance")
assert explicit_cpu[0]["lock"]["identity_template"] == \
       same_cpu[0]["lock"]["identity_template"]

fixed_three = lock_ops("fixed_per_cpu_instance")
fixed_four = lock_ops("different_fixed_per_cpu_instance")
assert fixed_three[0]["lock"]["identity_status"] == "symbolic"
assert fixed_four[0]["lock"]["identity_status"] == "symbolic"
assert fixed_three[0]["lock"]["identity_template"] != \
       fixed_four[0]["lock"]["identity_template"]
assert "constant(3)" in fixed_three[0]["lock"]["identity_template"]
assert "constant(4)" in fixed_four[0]["lock"]["identity_template"]

for function in ("unresolved_per_cpu_index", "computed_per_cpu_index",
                "call_computed_per_cpu_index"):
    unknown = lock_ops(function)
    assert len(unknown) == 1, (function, unknown)
    assert unknown[0]["lock"]["identity_status"] == "unresolved", (function, unknown)
    assert "unknown_index@" in unknown[0]["lock"]["identity_template"]

print("per-CPU identity, distinct indices, and unresolved-index tests passed")
