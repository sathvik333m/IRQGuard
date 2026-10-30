#!/usr/bin/env python3
"""Check structured uncertainty counts and preserved propagation evidence."""
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
assert report["schema_version"] == 4
summary = report["uncertainty_summary"]
records = report["uncertainty_records"]
assert summary["event_count"] == len(report["uncertainties"])
assert summary["unique_record_count"] == len(records)
assert summary["event_count"] > summary["unique_record_count"]
assert summary["propagated_event_count"] > 0
assert summary["proven_non_affecting_event_count"] == 0
assert summary["non_affecting_count_note"]
assert sum(v["event_count"] for v in summary["by_category"].values()) == summary["event_count"]
assert sum(v["unique_record_count"] for v in summary["by_category"].values()) == summary["unique_record_count"]
assert sum(v["event_count"] for v in summary["by_stage"].values()) == summary["event_count"]
assert sum(v["event_count"] for v in summary["by_function"].values()) == summary["event_count"]
assert sum(v["unique_record_count"] for v in summary["by_source_location"].values()) == summary["unique_record_count"]

body = [r for r in records if r["category"] == "unresolved_call"
        and r["reason"] == "missing_body"]
assert len(body) == 1, body
issue = body[0]
assert issue["unique_record"] is True
assert issue["cause_identity_is_heuristic"] is True
assert issue["event_count"] >= 2
assert issue["propagated_event_count"] >= 1
assert issue["source_location"]["valid"]
assert issue["source_location"]["line"] == 4
assert issue["enclosing_function"] == "uncertain_helper"
assert issue["severity"] == "medium"
assert issue["analysis_stage"] == "interprocedural"
assert issue["impact"] == "potential_lock_or_irq_effect"
assert issue["example_events"]
assert summary["by_function"]["uncertain_helper"]["event_count"] >= issue["event_count"]
assert any(key.endswith(":4:5") for key in summary["by_source_location"])

category = summary["by_category"]["unresolved_call"]
assert category["event_count"] == sum(r["event_count"] for r in body)
assert category["unique_record_count"] == len(body)
assert all(r["id"].startswith("U-") for r in records)
assert len({r["id"] for r in records}) == len(records)

# The offline evaluator uses the same category/cause identity rules as schema 4.
script = Path(__file__).resolve().parents[1] / "evaluation" / "summarize_uncertainties.py"
with tempfile.TemporaryDirectory(prefix="irqguard-uncertainty-test-") as temporary:
    reports = Path(temporary) / "reports"
    reports.mkdir()
    (reports / "fixture.json").write_text(run.stdout, encoding="utf-8")
    output = Path(temporary) / "summary.json"
    offline = subprocess.run([sys.executable, str(script), str(reports), str(output)],
                             text=True, capture_output=True)
    assert offline.returncode == 0, offline.stderr
    offline_report = json.loads(output.read_text(encoding="utf-8"))
    offline_summary = offline_report["aggregate"]
    assert offline_summary["event_count"] == summary["event_count"]
    assert offline_summary["unique_record_count"] == summary["unique_record_count"]
    assert offline_summary["propagated_event_count"] == summary["propagated_event_count"]
    assert offline_summary["by_function"] == summary["by_function"]
    assert offline_summary["by_source_location"] == summary["by_source_location"]
    assert {r["id"] for r in offline_report["records"]} == {r["id"] for r in records}
print("all uncertainty reporting tests passed")
