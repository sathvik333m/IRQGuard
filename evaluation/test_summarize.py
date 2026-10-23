#!/usr/bin/env python3
"""Tests the mode projection and SCC aggregation on known fixtures."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from summarize import cyclic_scc_count, summarize


def main() -> None:
    edges = [
        {"from_lock": "A", "to_lock": "B"},
        {"from_lock": "B", "to_lock": "A"},
        {"from_lock": "B", "to_lock": "C"},
        {"from_lock": "C", "to_lock": "D"},
        {"from_lock": "D", "to_lock": "C"},
        {"from_lock": "E", "to_lock": "E"},
        {"from_lock": "F", "to_lock": "G"},
    ]
    assert cyclic_scc_count(edges) == 3
    assert cyclic_scc_count([]) == 0

    analyzer = Path(sys.argv[1]).resolve()
    fixture = Path(sys.argv[2]).resolve()
    with tempfile.TemporaryDirectory(prefix="irqguard-phase6-fixture-") as temporary:
        path = Path(temporary) / "report.json"
        process = subprocess.run([str(analyzer), "analyze", "--source", str(fixture),
                                  "--format", "json", "--output", str(path)],
                                 capture_output=True, text=True, check=False, timeout=90)
        assert process.returncode == 0, process.stderr
        report = json.loads(path.read_text(encoding="utf-8"))

    result = summarize(report)
    assert result["basic_lock_cycle_view"]["cyclic_scc_count"] >= 1
    assert result["interrupt_aware_view"]["interrupt_aware_candidates"] >= 1
    refined = result["feasibility_refined_view"]
    assert refined["rejected_candidate"] >= 1
    assert refined["inconclusive_analysis"] >= 1
    assert refined["candidate_lock_order_cycle"] >= 1
    assert refined["interrupt_aware_candidate"] >= 1
    assert result["counts"]["functions"] == len(report["functions"])
    print("evaluation projection and controlled-fixture checks passed")


if __name__ == "__main__":
    main()
