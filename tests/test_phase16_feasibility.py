#!/usr/bin/env python3
"""Bounded path, IRQ-lifecycle, and classification regressions for Phase 16."""
import json
import subprocess
import sys

binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)
edges = report["interrupt_lock_graph"]["edges"]
cycles = report["interrupt_cycles"]


def regular(function, source, target):
    return [edge for edge in edges if edge["kind"] == "regular"
            and edge["source_function"] == function
            and source in edge["from_lock"] and target in edge["to_lock"]]


# Mutually exclusive branches cannot establish an A-held-then-B-acquired edge.
exclusive = regular("mutually_exclusive_dependency", "exclusive_a", "exclusive_b")
assert exclusive, "the graph-cycle candidate should remain visible for review"
assert all(edge["feasibility"] == "rejected" and
           edge["path_condition_status"] == "contradictory" and
           "contradictory supported branch predicates" in edge["feasibility_reason"]
           for edge in exclusive), exclusive
rejected_cycles = [cycle for cycle in cycles if cycle["category"] == "rejected_candidate"]
assert rejected_cycles, cycles
assert any("contradictory supported branch predicates" in cycle["explanation"]
           for cycle in rejected_cycles)
comparison = regular("complementary_comparison", "compare_a", "compare_b")
assert comparison and all(edge["feasibility"] == "rejected" and
                           edge["path_condition_status"] == "contradictory" for edge in comparison)

# Opposite orders in separate invocations remain plausible: a process can run
# each branch in different threads/calls, so branch guards are not conjoined
# across cycle edges.
ab = regular("opposite_orders_can_run_in_separate_calls", "opposite_a", "opposite_b")
ba = regular("opposite_orders_can_run_in_separate_calls", "opposite_b", "opposite_a")
assert ab and ba
assert all(edge["feasibility"] == "cfg_reachable" and
           edge["path_condition_status"] == "compatible" and edge["path_conditions"]
           for edge in ab + ba)
assert any(cycle["feasibility"] == "potentially_feasible" and
           cycle["category"] == "candidate_lock_order_cycle" for cycle in cycles)

# Early returns and a bounded loop do not erase a compatible lock order.
early = regular("early_return_order", "return_a", "return_b")
loop = regular("supported_loop_order", "loop_a", "loop_b")
nest = regular("nested_condition_path", "nested_a", "nested_b")
assert early and all(edge["path_condition_status"] == "compatible" for edge in early)
assert loop and all(edge["path_condition_status"] == "compatible" for edge in loop)
assert nest and all(edge["path_condition_status"] == "compatible" and
                    len(edge["path_conditions"]) >= 2 for edge in nest)

# A call-based condition is unsupported and remains visible as inconclusive.
unknown = regular("unsupported_condition_order", "summary_a", "summary_b")
assert unknown and all(edge["feasibility"] == "inconclusive" and
                       edge["path_condition_status"] == "inconclusive" for edge in unknown)
assert all(any(not condition["supported"] and condition["location"]["expansion"]["valid"]
               for condition in edge["path_conditions"]) for edge in unknown)
mutated = regular("reassigned_condition_is_unknown", "mutate_a", "mutate_b")
assert mutated and all(edge["feasibility"] == "inconclusive" for edge in mutated)

# A call-site dependency using an uncertain function summary cannot become a
# potentially-feasible conclusion merely because the graph has an edge.
summary_edges = [edge for edge in regular("incomplete_summary_order", "summary_a", "summary_b")
                 if edge["summary_status"] == "uncertain"]
assert summary_edges and all(edge["feasibility"] == "inconclusive" and
                              edge["certainty"] == "uncertain" for edge in summary_edges)

# request_irq resolves one handler; a matching free_irq is recorded as argument
# evidence only. It does not erase the handler or prove registration lifetime.
registrations = report["interrupt_registrations"]
known = next(item for item in registrations if item["handler_names"] == ["registered_handler"])
unknown_registration = next(item for item in registrations if item["resolution"] == "unresolved_handler")
deregistrations = report["interrupt_deregistrations"]
matched = next(item for item in deregistrations if item["argument_matched_registrations"])
assert matched["resolution"] == "exact_arguments_match_order_unproven"
assert matched["argument_matched_registrations"][0]["expansion"]["line"] == \
       known["location"]["expansion"]["line"]
preemption = [edge for edge in edges if edge["kind"] == "interrupt_preemption"
              and edge["handler"] == "registered_handler"]
assert preemption and all(edge["registration_lifecycle"] ==
                          "matching_free_irq_arguments_order_unproven" for edge in preemption)
assert all(edge["registration_location"]["expansion"]["valid"] for edge in preemption)
unknown_registration_line = unknown_registration["location"]["expansion"]["line"]
assert not any(edge["kind"] == "interrupt_preemption" and
               edge["registration_location"]["expansion"]["line"] == unknown_registration_line
               for edge in edges)

# irqrestore uses the saved flags state; acquisition is definitely IRQ-disabled
# and therefore cannot create its same-CPU preemption edge at that site.
save_api = next(api for api in report["api_operations"]
                if api["api"] == "spin_lock_irqsave" and api["caller"] == "irqsave_protects_handler_path")
save_line = save_api["location"]["expansion"]["line"]
save_snapshot = [item for item in report["interrupt_state_snapshots"]
                 if item["source_function"] == "irqsave_protects_handler_path"]
assert save_snapshot and all(item["irq_state"] == "disabled" for item in save_snapshot)
assert not any(edge["kind"] == "interrupt_preemption" and
               edge["from_location"]["expansion"]["line"] == save_line for edge in edges)

# Static categories never claim independent runtime confirmation.
assert all(cycle["category"] != "independently_confirmed" for cycle in cycles)
print("Phase 16 path feasibility, IRQ lifecycle, and classification checks passed")
