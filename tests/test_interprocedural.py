#!/usr/bin/env python3
import json
import subprocess
import sys


binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)
assert report["analysis_kind"] == "interrupt_aware_lock_analysis"
assert report["diagnostics"] == []
assert all(function["cfg_available"] and function["cfg_events_complete"]
           for function in report["functions"])
assert all(summary["converged"] for summary in report["function_summaries"])

summaries = {item["function"]: item for item in report["function_summaries"]}
dependencies = report["lock_dependencies"]

# Direct order wholly within one function.
direct = [item for item in dependencies if item["reporting_function"] == "same_function"]
assert any(item["origin"] == "direct" and item["from_lock"] == "@param[0]"
           and item["to_lock"] == "@param[1]" for item in direct)
assert summaries["same_function"]["releases"]
assert all(release["location"]["expansion"]["valid"]
           for release in summaries["same_function"]["releases"])

# The edge crosses two helper boundaries and carries both call sites.
cross = [item for item in dependencies if item["reporting_function"] == "cross_function"]
assert any(item["origin"] == "inferred_through_call"
           and [step["callee"] for step in item["through_calls"]] == ["bridge", "leaf"]
           for item in cross)

# A callee's must-release effect is substituted through the actual argument.
after_release = [item for item in dependencies
                 if item["reporting_function"] == "release_through_helper"]
assert any(item["from_lock"] == "@param[0]" and item["to_lock"] == "@param[2]"
           for item in after_release)
assert not any(item["from_lock"] == "@param[1]" and item["to_lock"] == "@param[2]"
               for item in after_release)

# Two static call sites remain distinguishable in provenance.
multi = [item for item in dependencies if item["reporting_function"] == "multiple_sites"]
site_lines = {item["through_calls"][0]["location"]["expansion"]["line"]
              for item in multi if item["through_calls"]}
assert len(site_lines) == 2, site_lines

# Both feasible branch orders are retained, while two similarly named local locks
# keep distinct declaration-based identities.
opposite = [item for item in dependencies if item["reporting_function"] == "opposite_orders"]
assert { (item["from_lock"], item["to_lock"]) for item in opposite } >= {
    ("@param[0]", "@param[1]"), ("@param[1]", "@param[0]")
}
similar = [item for item in dependencies if item["reporting_function"] == "similar_names"]
assert similar and all(item["from_lock"] != item["to_lock"] for item in similar)
assert all("device_lock" in item["from_lock"] or "device_lock2" in item["from_lock"]
           for item in similar)
local_acquisitions = summaries["local_calls_twice"]["acquisitions"]
local_identities = {item["lock_identity"] for item in local_acquisitions
                    if "local@" in item["lock_identity"]}
assert len(local_identities) == 2, local_identities

# A simple local function pointer resolves; an unbound function pointer does not.
calls = report["calls"]
known_indirect = [call for call in calls if call["caller"] == "resolved_indirect"
                  and call["callee"] == "callback"]
assert len(known_indirect) == 1
assert known_indirect[0]["resolution"] == "resolved_indirect"
assert known_indirect[0]["target_names"] == ["callback_target"]
unknown_indirect = [call for call in calls if call["caller"] == "unresolved_indirect"
                    and call["callee"] == "callback"]
assert len(unknown_indirect) == 1
assert unknown_indirect[0]["resolution"] == "unresolved_indirect"

# Direct recursion and mutual recursion are present in the graph and summaries converge.
graph_edges = report["call_graph"]["edges"]
assert any(edge["callee"] == "recursive_swap" and edge["resolution"] == "direct"
           for edge in graph_edges)
assert any(edge["callee"] == "mutual_b" for edge in graph_edges)
assert any(edge["callee"] == "mutual_a" for edge in graph_edges)
assert summaries["recursive_swap"]["converged"]
assert summaries["mutual_a"]["converged"] and summaries["mutual_b"]["converged"]

# Unknown external and indirect calls are explicit, including a held-lock context.
assert any("opaque_external" in uncertainty and "holding 1 lock" in uncertainty
           for uncertainty in report["uncertainties"])
assert any("unresolved call 'callback'" in uncertainty
           for uncertainty in report["uncertainties"])
assert any(edge["callee"] == "opaque_external" and edge["resolution"] == "external"
           for edge in graph_edges)

print("all interprocedural summary tests passed")
