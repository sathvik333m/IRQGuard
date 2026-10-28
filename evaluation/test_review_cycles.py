#!/usr/bin/env python3
"""Regression checks for the Phase 11 retrospective review artifact."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="irqguard-phase11-") as temp:
    output = Path(temp) / "cycle-review.json"
    result = subprocess.run([
        sys.executable, str(ROOT / "evaluation/review_cycles.py"),
        "--report", str(ROOT / "evaluation/results/linux-v6.6.87/reports/netdev.json"),
        "--uncertainties", str(ROOT / "evaluation/results/linux-v6.6.87/uncertainty-summary-phase10.json"),
        "--output", str(output),
    ], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    report = json.loads(output.read_text())

assert report["status"] == "archived_review_with_current_source_scan"
assert report["current_analysis"]["status"] == "completed_with_validation_skips"
assert report["current_analysis"]["aggregate"]["counts_sum_across_translation_units"]["interrupt_cycles"] == 0
assert report["current_analysis"]["validation"]["objtool_object_checks"] == "skipped_by_request"
assert report["input"]["sha256"] == "1413deebf409eb04a7c0a22e7eae35fc7d33897f69fd080bafa3095f54ba489c"
assert len(report["findings"]) == 3
for i, finding in enumerate(report["findings"], 1):
    assert finding["finding_id"] == f"C-{i}"
    assert finding["classification"] == "inconclusive"
    assert finding["archived_edge_is_self_edge"]
    assert finding["edges"][0]["certainty"] == "uncertain"
    assert finding["edges"][0]["feasibility"] == "unrefined"
    assert finding["interrupt_evidence"]["handler"] is None
    assert len(finding["uncertainties"]) == 5
    assert finding["source_file"].endswith("netdev.c")
    assert finding["call_path"]
print("Phase 11 archived review checks passed: 3 inconclusive cycle records")
