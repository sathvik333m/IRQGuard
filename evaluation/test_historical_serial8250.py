#!/usr/bin/env python3
"""Check the archived 8250 lockdep case's paired analyzer reports."""

import json
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
summary = json.loads(summary_path.read_text(encoding="utf-8"))
assert summary["case_id"] == "linux-8250-startup-lock-order-2020"
assert summary["results"]["affected"]["revision"] == "547bbf7d214fff2d29bc885ea7efea0fbc127791"
assert summary["results"]["fixed"]["revision"] == "730037c3ee57f892e6df019bc88d417a5944737c"
assert summary["results"]["affected"]["config_sha256"] == summary["results"]["fixed"]["config_sha256"]
assert summary["validation"]["classification"] == "miss"
assert summary["validation"]["affected_external_disable_irq_call_seen"]
assert summary["validation"]["unsupported_disable_irq_api_uncertainty"]
assert not summary["validation"]["affected_lockdep_pattern_reported"]

for name in ("affected", "fixed"):
    raw = summary_path.parent / summary["results"][name]["report"]
    report = json.loads(raw.read_text(encoding="utf-8"))
    assert report["lock_dependencies"] == []
    assert report["interrupt_cycles"] == []
    assert report["diagnostics"] == []
    assert summary["results"][name]["measurements"]["lock_operations"] == 39

affected = json.loads((summary_path.parent / summary["results"]["affected"]["report"]).read_text(encoding="utf-8"))
assert any(
    call.get("callee") == "disable_irq_nosync" and call.get("resolution") == "external"
    for call in affected["calls"]
)
assert any("disable_irq_nosync" in str(item) for item in affected["uncertainties"])
print("Historical 8250 lockdep case comparison passed")
