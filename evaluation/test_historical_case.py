#!/usr/bin/env python3
"""Check the archived historical case's paired-run assertions."""

import json
import sys
from pathlib import Path


summary_path = Path(sys.argv[1])
summary = json.loads(summary_path.read_text(encoding="utf-8"))
assert summary["case_id"] == "linux-mips-gic-recursive-lock-2026"
assert summary["results"]["affected"]["revision"] == "03c4d26933d54556a89379db5923ae9e474569e8"
assert summary["results"]["fixed"]["revision"] == "1bae25dcc6beb8b874f23601d2efa142ac4f9f36"
assert summary["results"]["affected"]["config_sha256"] == summary["results"]["fixed"]["config_sha256"]
assert summary["validation"]["classification"] == "partial_match"
assert summary["validation"]["affected_recursive_lock_pattern_detected"]
assert summary["validation"]["fixed_revision_has_no_reported_cycle"]
assert not summary["validation"]["fixed_guard_lock_operation_extracted"]

for name in ("affected", "fixed"):
    report_path = summary_path.parent / summary["results"][name]["report"]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["diagnostics"] == []
    counts = summary["results"][name]["measurements"]
    assert counts["parser_diagnostics"] == 0

affected = json.loads((summary_path.parent / summary["results"]["affected"]["report"]).read_text(encoding="utf-8"))
cycles = affected["interrupt_cycles"]
assert len(cycles) == 1
assert cycles[0]["category"] == "inconclusive_analysis"
assert any(
    edge["source_function"] == "gic_set_affinity"
    and edge["target_function"] == "gic_set_type"
    and edge["from_lock"] == edge["to_lock"]
    for cycle in cycles for edge in cycle["edges"]
)
print("Historical MIPS GIC affected/fixed comparison passed")
