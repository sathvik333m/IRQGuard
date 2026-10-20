#!/usr/bin/env python3
import json
import subprocess
import sys


binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)
assert report["schema_version"] == 3
assert report["analysis_kind"] == "interrupt_aware_lock_analysis"

registrations = report["interrupt_registrations"]
known = [r for r in registrations if r["api"] == "request_irq" and r["handler_names"]]
assert {r["handler_names"][0] for r in known} >= {
    "cross_handler", "second_handler", "blocked_handler", "ambiguous_handler"
}
assert all(r["location"]["expansion"]["valid"] for r in known)
assert any(r["resolution"] == "resolved_indirect" and
           r["handler_names"] == ["second_handler"] for r in known)
unknown_registration = [r for r in registrations if r["handler_names"] == []]
assert any(r["resolution"] == "unresolved_handler" for r in unknown_registration)
assert any("unresolved interrupt handler registration" in u for u in report["uncertainties"])
assert any("interrupt teardown/lifecycle for 'free_irq' is not modeled" in u
           for u in report["uncertainties"])

snapshots = report["interrupt_state_snapshots"]
def selected(function, lock_name):
    return [s for s in snapshots if s["source_function"] == function
            and lock_name in s["lock_identity"]]

# The helper lock acquisition is inlined into the caller's context and retains
# its call-site provenance. The process holds cross_a while entering the helper.
cross_b = selected("process_cross_context", "cross_b")
assert cross_b and any(s["through_calls"] and
                       s["through_calls"][0]["callee"] == "acquire_cross_b"
                       for s in cross_b)
assert all(s["context"] == "process" and s["irq_state"] == "enabled"
           for s in cross_b)

edges = report["interrupt_lock_graph"]["edges"]
cross_edges = [e for e in edges if e["kind"] == "interrupt_preemption"
               and "cross_a" in e["from_lock"] and "cross_b" in e["to_lock"]]
assert cross_edges, "expected process-to-hardirq preemption edge"
assert all(e["from_context"] == "process" and e["to_context"] == "hardirq"
           for e in cross_edges)
assert any(e["handler"] == "cross_handler" for e in cross_edges)
assert all(e["registration_location"]["expansion"]["valid"] for e in cross_edges)
assert any(e["from_lock"] == e["to_lock"] for e in edges if e["kind"] == "regular") is False

# The ordinary order cycle is retained as a possible cycle.
assert any(c["classification"] == "normal_lock_cycle" for c in report["interrupt_cycles"])

# The enabled process->handler edge plus the handler's reverse dependency forms
# a candidate interrupt cycle; it is never labelled a confirmed deadlock.
cross_cycles = [c for c in report["interrupt_cycles"]
                if c["classification"] == "interrupt_preemption_candidate"
                and any("cross_a" in e["from_lock"] and "cross_b" in e["to_lock"]
                        for e in c["edges"] if e["kind"] == "interrupt_preemption")]
assert cross_cycles
assert all("Not a confirmed deadlock" in c["explanation"] for c in cross_cycles)
for candidate in (c for c in report["interrupt_cycles"]
                  if c["classification"] == "interrupt_preemption_candidate"):
    interruption = next(e for e in candidate["edges"] if e["kind"] == "interrupt_preemption")
    assert all(e["handler"] == interruption["handler"]
               for e in candidate["edges"] if e["kind"] == "regular"
               and e["to_context"] == "hardirq")

# local_irq_disable in a wrapper suppresses preemption edges until explicit
# local_irq_enable. In particular, the blocked_a -> blocked_b candidate cycle
# must not be created from this region.
blocked_snapshots = [s for s in snapshots if s["source_function"] == "process_with_irqs_disabled"
                     and ("blocked_a" in s["lock_identity"] or "blocked_b" in s["lock_identity"])]
assert blocked_snapshots and all(s["irq_state"] == "disabled" for s in blocked_snapshots)
assert not any(e["kind"] == "interrupt_preemption" and "blocked_a" in e["from_lock"]
               and "blocked_b" in e["to_lock"] for e in edges)
assert not any(c["classification"] == "interrupt_preemption_candidate"
               and any("blocked_a" in e["from_lock"] or "blocked_b" in e["from_lock"]
                       for e in c["edges"]) for c in report["interrupt_cycles"])

# At a CFG join of enabled and disabled paths, the IRQ state is unknown. The
# analyzer keeps a qualified candidate rather than falsely calling it disabled.
ambiguous = [s for s in snapshots
             if s["source_function"] == "process_with_path_dependent_irq_state"
             and "ambiguous_b" in s["lock_identity"]]
assert ambiguous and all(s["irq_state"] == "unknown" for s in ambiguous)
uncertain_edges = [e for e in edges if e["kind"] == "interrupt_preemption"
                   and "ambiguous_a" in e["from_lock"] and "ambiguous_b" in e["to_lock"]]
assert uncertain_edges and all(e["certainty"] == "uncertain" for e in uncertain_edges)

# irqsave disables before the lock and irqrestore restores the state saved in
# its flags expression. Nested irqsave from a disabled state restores disabled.
expected = {
    "state_a": "disabled", "state_b": "disabled", "state_c": "enabled",
    "state_d": "disabled", "state_e": "disabled", "state_f": "enabled",
}
for lock_name, state in expected.items():
    facts = selected("irqsave_restore_cases", lock_name)
    assert facts and all(item["irq_state"] == state for item in facts), (lock_name, facts)
assert all(item["irq_state"] == "disabled"
           for item in selected("irqsave_wrapper_cases", "state_b"))
assert all(item["irq_state"] == "enabled"
           for item in selected("irqsave_wrapper_cases", "state_c"))
unmatched = selected("unmatched_irqrestore_case", "state_b")
assert unmatched and all(item["irq_state"] == "unknown" for item in unmatched)
assert any("irqrestore has no matching saved state" in u for u in report["uncertainties"])

# Unsupported lock API names and unknown lock expressions are reported.
assert any("possibly unsupported lock/IRQ API 'spin_lock_irq'" in u
           for u in report["uncertainties"])
assert any(api["api"] == "spin_lock" and api["lock"] is not None
           and api["lock"]["identity_status"] == "unresolved"
           for api in report["api_operations"])
assert any("unmodeled call may alter IRQ state: 'get_lock'" in u
           for u in report["uncertainties"])

print("all interrupt-aware tests passed")
