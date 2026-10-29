#!/usr/bin/env python3
"""Regression tests for direct and summary-instantiated lock dependencies."""

import json
import subprocess
import sys


binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)
dependencies = report["lock_dependencies"]


def edges_for(function):
    return [item for item in dependencies if item["reporting_function"] == function]


# Directed edge convention: earlier-held lock -> newly acquired lock.
ab = edges_for("nested_ab")
assert any(item["from_lock"] == "@param[0]" and
           item["to_lock"] == "@param[1]" and item["origin"] == "direct"
           for item in ab), ab
ba = edges_for("nested_ba")
assert any(item["from_lock"] == "@param[1]" and
           item["to_lock"] == "@param[0]" and item["origin"] == "direct"
           for item in ba), ba

# Provenance must identify both acquisitions and valid source coordinates.
for dependency in ab + ba:
    assert dependency["from_acquisition"]["expansion"]["valid"]
    assert dependency["to_acquisition"]["expansion"]["valid"]
    assert dependency["from_acquisition"]["expansion"]["line"] != \
           dependency["to_acquisition"]["expansion"]["line"]

# No relationship is inferred when locks are released before the next acquire,
# or when mutually exclusive branches each acquire and release one lock.
assert not edges_for("independent_locks")
assert not edges_for("lock_pairs_without_nesting")
assert not edges_for("mutually_exclusive_locks")

# A known helper summary contributes the dependency with call-site provenance.
through = edges_for("dependency_through_summary")
assert any(item["from_lock"] == "@param[0]" and
           item["to_lock"] == "@param[1]" and
           item["origin"] == "inferred_through_call" and
           [step["callee"] for step in item["through_calls"]] == ["acquire_b"]
           for item in through), through

# Unsupported lock identity remains explicitly uncertain; it must not become a
# definite edge with a guessed identity. The external call adds uncertainty but
# no invented lock event/dependency.
uncertain = edges_for("unresolved_nested_expression")
assert uncertain
assert all(item["certainty"] == "unresolved_identity" for item in uncertain)
assert any("unknown_lock()" in item.get("to_lock", "") or
           "unknown" in item.get("to_lock", "") for item in uncertain)
assert not edges_for("unavailable_summary_does_not_invent_order")
assert any("external_helper" in message and "holding 1 lock" in message
           for message in report["uncertainties"])

print("lock dependency generation positives, negatives, summaries and uncertainty passed")
