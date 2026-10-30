#!/usr/bin/env python3
"""Integration check for the Phase 17 dataset evaluator."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
dataset = json.loads((root / "evaluation/dataset-v1.json").read_text(encoding="utf-8"))
cases = dataset["cases"]
assert len({case["id"] for case in cases}) == len(cases)
required = {"id", "group", "split", "source", "expected_behavior", "rationale",
            "evidence_source", "validation_method", "known_limitations"}
assert all(required <= case.keys() for case in cases)
assert all((root / case["source"]).is_file() for case in cases if case["group"] != "real_kernel_exploratory")
assert dataset["independent_bug_cases"] == []
with tempfile.TemporaryDirectory(prefix="irqguard-phase17-test-") as temporary:
    output = Path(temporary) / "phase17"
    run = subprocess.run([sys.executable, str(root / "evaluation/run_phase17.py"),
                          "--analyzer", sys.argv[1], "--output", str(output)],
                         cwd=root, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, f"{run.stdout}\n{run.stderr}"
    summary = json.loads((output / "summary.json").read_text(encoding="utf-8"))
    assert summary["controlled_fixture_passed"] == 8
    assert summary["controlled_fixture_failed"] == 0
    assert len(summary["real_kernel_cases"]) == 5
    assert all(row["label_status"] == "unlabeled_exploratory" for row in summary["real_kernel_cases"])
    assert summary["ground_truth"]["precision"] is None
    assert summary["ground_truth"]["recall"] is None
    assert summary["kernel_pin_validation"]["status"] in {
        "matched", "mismatch", "checkout_unavailable_archived_reports_only"
    }
print("Phase 17 dataset and evaluation runner passed")
