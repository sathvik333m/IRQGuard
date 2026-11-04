#!/usr/bin/env python3
"""Only exact, known compiler intrinsics receive neutral lock/IRQ effects."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)
messages = report["uncertainties"]
for name in ("__builtin_constant_p", "__builtin_ffsll", "__builtin_bswap16",
             "__builtin_expect", "__builtin_prefetch", "ktime_to_ns",
             "timecounter_cyc2time"):
    assert not any(name in item for item in messages), messages
assert any("__builtin_unreachable" in item for item in messages), messages
assert any("opaque_external" in item and "external or unavailable body" in item
           for item in messages), messages
assert any("opaque_external" in item and "unmodeled call may alter IRQ state" in item
           for item in messages), messages

records = report["uncertainty_records"]
irq_effects = [r for r in records if r["reason"] == "unknown_call_irq_effect"
               and r["api_or_expression"] == "opaque_external"]
call_roots = [r for r in records if r["category"] == "unresolved_call"
              and r["api_or_expression"] == "opaque_external"]
assert len(irq_effects) == len(call_roots) == 1
assert irq_effects[0]["root_cause_id"] == call_roots[0]["id"]
assert irq_effects[0]["causal_relation"] == "secondary_irq_effect_of_unresolved_call"
assert irq_effects[0]["causal_parent_ids"] == [call_roots[0]["id"]]
assert call_roots[0]["causal_parent_ids"] == []

snapshot = next(s for s in report["interrupt_state_snapshots"]
               if s["source_function"] == "exact_pure_builtins")
assert snapshot["irq_state"] != "unknown", snapshot

impact_script = Path(__file__).resolve().parents[1] / "evaluation" / "analyze_uncertainty_impact.py"
with tempfile.TemporaryDirectory(prefix="irqguard-impact-test-") as temporary:
    reports = Path(temporary) / "reports"
    reports.mkdir()
    (reports / "fixture.json").write_text(run.stdout, encoding="utf-8")
    output = Path(temporary) / "impact.json"
    impact = subprocess.run([sys.executable, str(impact_script), str(reports), str(output)],
                            text=True, capture_output=True)
    assert impact.returncode == 0, impact.stderr
    impact_data = json.loads(output.read_text(encoding="utf-8"))
    assert impact_data["root_cause_count"] == 2
    opaque = next(r for r in impact_data["roots"] if r["callee"] == "opaque_external")
    assert opaque["unresolved_call_events"] == 1
    assert opaque["irq_state_effect_events"] == 1
    assert opaque["functions"] == ["unrelated_unknown_call"]
    assert any(r["callee"] == "__builtin_unreachable" for r in impact_data["roots"])
print("known compiler builtin effect regression passed")
