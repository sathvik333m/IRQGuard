#!/usr/bin/env python3
import json
import subprocess
import sys


binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)
cycles = report["interrupt_cycles"]
graph_edges = report["interrupt_lock_graph"]["edges"]
assert any(e["feasibility"] == "cfg_reachable" and
           "source lock remains held" in e["feasibility_reason"] for e in graph_edges)
assert not any(e["source_function"] == "release_before_next_acquire" and
               "state_a" in e["from_lock"] and "state_b" in e["to_lock"]
               for e in graph_edges), "a release must end the held-lock ordering"

# A simple normal cycle and a process-to-hardirq cycle carry source-ordered,
# closed lock sequences and enough edge provenance to inspect every step.
normal = [c for c in cycles if c["category"] == "candidate_lock_order_cycle"]
interrupt = [c for c in cycles if c["category"] == "interrupt_aware_candidate"]
assert normal and interrupt
for finding in normal + interrupt:
    assert len(finding["lock_sequence"]) >= 3
    assert finding["lock_sequence"][0] == finding["lock_sequence"][-1]
    assert finding["edges"]
    assert all(e["from_location"]["expansion"]["valid"] and
               e["to_location"]["expansion"]["valid"] for e in finding["edges"])
    assert finding["provenance_variants"]

# The blocked fixture has the same lock order shape as a preemption cycle, but
# local hard IRQs are definitely disabled at its process-side acquisition.
rejected = [c for c in cycles if c["category"] == "rejected_candidate"]
blocked = [c for c in rejected if any("blocked_a" in lock for lock in c["lock_sequence"])]
assert blocked, "expected explicit rejected finding for the IRQ-disabled cycle shape"
assert all(c["feasibility"] == "rejected" for c in blocked)
assert any(e["kind"] == "interrupt_preemption_rejected" and
           e["irq_state"] == "disabled" and e["feasibility_reason"]
           for c in blocked for e in c["edges"])
assert not any(c["category"] == "interrupt_aware_candidate" and
               any("blocked_a" in lock for lock in c["lock_sequence"])
               for c in cycles)

# The path-dependent IRQ join remains inconclusive. It is not converted into a
# confirmed candidate or rejected based on one branch alone.
inconclusive = [c for c in cycles if c["category"] == "inconclusive_analysis"]
assert any(any("ambiguous_a" in lock for lock in c["lock_sequence"])
           for c in inconclusive)

dot = subprocess.run([binary, "analyze", "--source", fixture, "--format", "dot"],
                     text=True, capture_output=True)
assert dot.returncode == 0, dot.stderr
assert dot.stdout.startswith("digraph interrupt_lock_dependencies {")
assert "interrupt_preemption" in dot.stdout and "color=\"red\"" in dot.stdout
assert "style=\"dashed\"" in dot.stdout

print("all feasibility and cycle-report tests passed")
