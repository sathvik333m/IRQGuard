#!/usr/bin/env python3
"""Regression checks for the reproducible Phase 13 before/after artifact."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="irqguard-phase13-") as temporary:
    output = Path(temporary) / "comparison.json"
    subprocess.run([sys.executable, str(ROOT / "evaluation/compare_phase13.py"),
                    "--output", str(output)], cwd=ROOT, check=True,
                   capture_output=True, text=True)
    result = json.loads(output.read_text())
before, after = result["before"], result["after"]
assert result["comparable_setup"]["kernel_revision"] == "814637ca257f4faf57a73fd4e38888cce88b5911"
assert result["comparable_setup"]["source_files"] == ["netdev.c", "ethtool.c", "ich8lan.c", "phy.c", "nvm.c"]
assert before["files"] == after["files"] == 5
assert before["functions"] == after["functions"] == 396
assert before["lock_acquisitions"] == after["lock_acquisitions"] == 6
assert before["lock_releases"] == after["lock_releases"] == 6
assert before["lock_identity_statuses"].get("unresolved") == 2
assert after["lock_identity_statuses"] == {"symbolic": 12}
assert before["candidate_cycles"] == 3
assert before["candidate_classifications"] == {"inconclusive_analysis": 3}
assert after["candidate_cycles"] == 0
assert before["uncertainty_events"] == 43705
assert before["unique_uncertainty_records"] == 4872
assert after["uncertainty_events"] == 43514
assert after["unique_uncertainty_records"] == 4833
assert after["validation"]["objtool_object_checks"] == "succeeded"
assert after["validation"]["orc_sections_present"] is True
assert after["validation"]["kernel_module_link"].startswith("not_attempted")
print("Phase 13 comparison checks passed: same pinned source/config, extracted counts, and bounded validation claims")
