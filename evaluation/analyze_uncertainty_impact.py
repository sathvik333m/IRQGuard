#!/usr/bin/env python3
"""Rank unresolved-call root causes without conflating propagated events.

The output keeps call sites separate and exposes frequency, propagated volume,
functions touched, lock-held occurrences, paired IRQ effects, and finding/edge
overlap. Ranking is lexicographic for triage, not a calibrated risk score.
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

CALL = re.compile(r"(?:call to external or unavailable body|unresolved call|unmodeled call may alter IRQ state):? '([^']*)' at (.+):(\d+):(\d+)")
VIA = re.compile(r"via call ([^ ]+) at ")


def event_functions(message: str) -> set[str]:
    found: set[str] = set()
    prefix = message
    if prefix.startswith("IRQ state "):
        prefix = prefix[len("IRQ state "):]
        prefix = prefix.split(": ", 1)[0].split("@", 1)[0]
        if prefix:
            found.add(prefix)
    else:
        prefix = prefix.split(": ", 1)[0]
        if prefix and not prefix.startswith("via call "):
            found.add(prefix)
    found.update(VIA.findall(message))
    return found


def summarize(report_dir: Path) -> dict[str, Any]:
    roots: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}
    for path in sorted(report_dir.glob("*.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        cycles = report.get("interrupt_cycles", [])
        edge_locations = set()
        for cycle in cycles:
            for edge in cycle.get("edges", []):
                for field in ("from_location", "to_location"):
                    point = edge.get(field, {}).get("expansion", {})
                    if point.get("file") and point.get("line"):
                        edge_locations.add((point["file"], str(point["line"])))
        dependency_locations = set()
        for dependency in report.get("lock_dependencies", []):
            for field in ("from_acquisition", "to_acquisition"):
                point = dependency.get(field, {}).get("expansion", {})
                if point.get("file") and point.get("line"):
                    dependency_locations.add((point["file"], str(point["line"])))
        for message in report.get("uncertainties", []):
            is_call = "call to external or unavailable body" in message or "unresolved call '" in message
            is_irq_effect = "unmodeled call may alter IRQ state" in message
            if not (is_call or is_irq_effect):
                continue
            match = CALL.search(message)
            if not match:
                continue
            callee, source, line, column = match.groups()
            key = (path.name, callee, source, line, column)
            record = roots.setdefault(key, {
                "translation_unit": path.name, "callee": callee,
                "source_file": source, "line": int(line), "column": int(column),
                "unresolved_call_events": 0, "irq_state_effect_events": 0,
                "propagated_events": 0, "lock_held_events": 0,
                "functions": set(), "related_finding_ids": set(),
                "related_edge_source_site": False, "related_dependency_count": 0,
            })
            record["functions"].update(event_functions(message))
            if is_call:
                record["unresolved_call_events"] += 1
                if "via call " in message or ": via " in message:
                    record["propagated_events"] += 1
                if " while holding " in message:
                    record["lock_held_events"] += 1
            if is_irq_effect:
                record["irq_state_effect_events"] += 1
            if (source, line) in edge_locations:
                record["related_edge_source_site"] = True
            if (source, line) in dependency_locations:
                record["related_dependency_count"] += 1
            for index, cycle in enumerate(cycles, 1):
                evidence = "\n".join(cycle.get("lock_sequence", []))
                if f"{source}:{line}:" in evidence:
                    record["related_finding_ids"].add(cycle.get("finding_id", f"C-{index}"))

    output = []
    for record in roots.values():
        record["functions"] = sorted(record["functions"])
        record["function_count"] = len(record["functions"])
        record["related_finding_ids"] = sorted(record["related_finding_ids"])
        output.append(record)
    # Triage order only: observed findings/edges, lock-held calls, IRQ effects,
    # number of functions, then frequency. It is not a probability/risk score.
    output.sort(key=lambda r: (
        -bool(r["related_finding_ids"]), -r["related_edge_source_site"],
        -bool(r["lock_held_events"]), -r["irq_state_effect_events"],
        -r["function_count"], -r["unresolved_call_events"],
        r["source_file"], r["line"], r["callee"],
    ))
    return {
        "schema_version": 1,
        "ranking_note": "Lexicographic investigation order; not a calibrated risk score.",
        "root_cause_count": len(output),
        "raw_unresolved_call_events": sum(r["unresolved_call_events"] for r in output),
        "raw_irq_effect_events": sum(r["irq_state_effect_events"] for r in output),
        "roots": output,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: analyze_uncertainty_impact.py REPORT_DIR OUTPUT.json", file=sys.stderr)
        return 2
    try:
        result = summarize(Path(sys.argv[1]))
        output = Path(sys.argv[2])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError, TypeError) as error:
        print(f"uncertainty impact analysis error: {error}", file=sys.stderr)
        return 1
    print(json.dumps({k: result[k] for k in (
        "root_cause_count", "raw_unresolved_call_events", "raw_irq_effect_events")}, indent=2))
    for item in result["roots"][:12]:
        print(f"{item['unresolved_call_events']:5d} call / {item['irq_state_effect_events']:5d} IRQ; "
              f"held={item['lock_held_events']:3d}; functions={item['function_count']:3d}; "
              f"{item['callee']} at {Path(item['source_file']).name}:{item['line']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
