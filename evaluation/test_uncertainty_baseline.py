#!/usr/bin/env python3
"""Reproduce the Phase 9.0 uncertainty counts without touching saved reports."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

script, reports_path = map(Path, sys.argv[1:])
expected_hashes = {
    "ethtool.json": "b9cb34d2f355a6f6edcd8d129e1577cbe0f8fed8208c4b7e404a20026b658542",
    "ich8lan.json": "e066baddf38883d2fc08c1332c8307c1259f93220b353f0649e2f149504db5fb",
    "netdev.json": "1413deebf409eb04a7c0a22e7eae35fc7d33897f69fd080bafa3095f54ba489c",
    "nvm.json": "c829bc9bca44338b0334502c950c486530996904e4f6cd3dfbd1e3714984f4e2",
    "phy.json": "58b8efcf73169a17097f46968e3f29b3418d1d89473aff70c082ab0c10423b3f",
}
for name, digest in expected_hashes.items():
    import hashlib
    assert hashlib.sha256((reports_path / name).read_bytes()).hexdigest() == digest, name

with tempfile.TemporaryDirectory(prefix="irqguard-phase10-baseline-") as temporary:
    output = Path(temporary) / "summary.json"
    run = subprocess.run([sys.executable, str(script), str(reports_path), str(output)],
                         text=True, capture_output=True)
    assert run.returncode == 0, run.stderr
    result = json.loads(output.read_text(encoding="utf-8"))

aggregate = result["aggregate"]
assert aggregate["event_count"] == 43705
assert aggregate["unique_record_count"] == 4872
assert aggregate["propagated_event_count"] == 38771
assert aggregate["high_impact_unique_records"] == 2636
assert aggregate["lock_identity_events"] == 30
assert aggregate["interrupt_state_events"] == 21734
assert aggregate["unresolved_call_events"] == 21742
assert aggregate["candidate_affecting_unique_records"] == 5
assert aggregate["affected_candidate_count"] == 3
assert aggregate["candidate_record_association_count"] == 15
assert aggregate["proven_non_affecting_event_count"] == 0
assert sum(item["event_count"] for item in result["translation_units"]) == 43705
assert len(result["candidate_affecting_records"]) == 5
assert all("netdev.c" in record["source_file"] and record["line"] == "501"
           for record in result["candidate_affecting_records"])
assert all(set(record["associated_findings"]) == {"C-1", "C-2", "C-3"}
           for record in result["candidate_affecting_records"])
print("Phase 9.0 uncertainty baseline reproduced: 43705 events, 4872 grouped records")
