#!/usr/bin/env python3
"""Classify raw uncertainty strings without deleting or rewriting them.

Accepts schema-v3 reports (for retrospective evaluation) and schema-v4 reports.
The classifier mirrors the stable message rules in src/Output.cpp. Cause keys
remove only propagation prefixes and presentation suffixes; source locations,
API operands, and distinct reasons remain part of the key.
"""
from __future__ import annotations

import json
import hashlib
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

RULES = [
    ("call to external or unavailable body", "unresolved_call", "missing_body", "interprocedural", "potential_lock_or_irq_effect", "medium", "A called function body is unavailable, so its effects cannot be summarized."),
    ("unresolved call '", "unresolved_call", "indirect_target_unknown", "interprocedural", "potential_lock_or_irq_effect", "high", "The call target could not be resolved; it may change held locks or interrupt state."),
    ("lock identity unresolved", "lock_identity", "lock_expression_unresolved", "lock_extraction", "lock_identity_and_edges", "high", "The lock expression could not be mapped to a stable lock identity."),
    ("irqsave flags argument unresolved", "interrupt_state", "saved_flags_unresolved", "interrupt_state", "interrupt_state", "high", "The irqsave operation was found, but its saved interrupt-state value is unknown."),
    ("irqrestore has no matching saved state", "interrupt_state", "restore_state_unmatched", "interrupt_state", "interrupt_state", "high", "The restore does not match a saved-state identity in the modeled path."),
    ("local_irq_save flags expression unresolved", "interrupt_state", "saved_flags_unresolved", "interrupt_state", "interrupt_state", "high", "The local IRQ save value could not be identified."),
    ("local_irq_restore has no matching saved state", "interrupt_state", "restore_state_unmatched", "interrupt_state", "interrupt_state", "high", "The local IRQ restore does not match a saved-state identity."),
    ("unmodeled call may alter IRQ state", "interrupt_state", "unknown_call_irq_effect", "interrupt_state", "interrupt_state", "high", "An unmodeled call may change interrupt state."),
    ("interrupt teardown/lifecycle", "handler_lifecycle", "teardown_not_modeled", "handler_discovery", "handler_lifecycle", "medium", "Interrupt handler deregistration timing is not modeled."),
    ("unresolved interrupt handler registration", "handler_resolution", "registration_unresolved", "handler_discovery", "handler_identity", "high", "The registered interrupt handler target could not be resolved."),
    ("handler target for '", "handler_resolution", "handler_target_unresolved", "handler_discovery", "handler_identity", "high", "A handler argument could not be resolved to a function definition."),
    ("possibly unsupported lock/IRQ API", "unsupported_api", "api_semantics_missing", "api_model", "heuristic_name_match_may_be_false_positive", "medium", "An API name matched a lock/IRQ warning heuristic, but its semantics are not modeled."),
    ("call events could not be mapped into the CFG", "control_flow", "cfg_event_unmapped", "control_flow", "path_and_dependency_analysis", "high", "A call event is absent from the CFG mapping, limiting path and summary analysis."),
    ("IRQ-state analysis has unmapped call events", "control_flow", "cfg_event_unmapped", "control_flow", "interrupt_state", "high", "IRQ-state transfer could not map all calls to CFG events."),
    ("CFG unavailable", "control_flow", "cfg_unavailable", "control_flow", "path_and_dependency_analysis", "high", "Control-flow data is unavailable for this function."),
    ("fixed point did not converge", "analysis_limit", "summary_nonconvergence", "summary_propagation", "lock_and_interrupt_summaries", "high", "The bounded summary iteration did not converge."),
    ("iteration limit reached", "analysis_limit", "iteration_limit", "summary_propagation", "lock_and_interrupt_summaries", "high", "A bounded analysis iteration limit was reached."),
    ("capped at", "analysis_limit", "output_or_search_cap", "graph_search", "candidate_completeness", "high", "An output or graph search cap may omit additional results."),
]


def stable_id(key: str) -> str:
    value = 14695981039346656037
    for byte in key.encode("utf-8"):
        value ^= byte
        value = (value * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return f"U-{value:016x}"


def classify(message: str) -> dict[str, str]:
    rule = next((r for r in RULES if r[0] in message), None)
    if rule is None:
        rule = ("", "other", "unclassified", "analysis", "unknown", "medium",
                "The uncertainty was retained but did not match a known diagnostic rule.")
    marker, category, reason, stage, impact, severity, explanation = rule
    start = message.find(marker) if marker else -1
    cause = message[start:] if start >= 0 else message
    cause = cause.split(" while holding ", 1)[0]
    cause = cause.split("; add an explicit API model", 1)[0].strip()
    if " while holding " in message:
        severity, impact = "high", "lock_held_across_unknown_call"
    locations = list(re.finditer(r"([^\s]+):(\d+):(\d+)", cause))
    location = locations[-1] if locations else None
    api_match = re.search(r"'([^']*)'", cause)
    return {
        "category": category, "reason": reason, "analysis_stage": stage,
        "impact": impact, "severity": severity, "explanation": explanation,
        "root_cause": cause,
        "source_file": location.group(1) if location else "",
        "line": location.group(2) if location else "0",
        "column": location.group(3) if location else "0",
        "api_or_expression": api_match.group(1) if api_match else "",
    }


def grouped_records(records: Any, field: str, fallback: str) -> dict[str, dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for item in records:
        if field == "source_location":
            key = (f"{item['source_file']}:{item['line']}:{item['column']}"
                   if item["source_file"] and item["line"] != "0" else fallback)
        else:
            key = item.get(field) or fallback
        bucket = buckets.setdefault(key, {
            "event_count": 0, "unique_record_count": 0,
            "by_category": {}, "by_stage": {},
        })
        bucket["event_count"] += item["event_count"]
        bucket["unique_record_count"] += 1
        for table_name, value in (("by_category", item["category"]),
                                  ("by_stage", item["analysis_stage"])):
            counts = bucket[table_name].setdefault(value, {
                "event_count": 0, "unique_record_count": 0,
            })
            counts["event_count"] += item["event_count"]
            counts["unique_record_count"] += 1
    return {key: buckets[key] for key in sorted(buckets)}


def summarize(report: dict[str, Any]) -> dict[str, Any]:
    events = report.get("uncertainties", [])
    grouped: dict[str, dict[str, Any]] = {}
    score: dict[str, tuple[int, int]] = {}
    for message in events:
        info = classify(message)
        key = info["category"] + "|" + info["root_cause"]
        record = grouped.setdefault(key, {
            "id": stable_id(key),
            **info, "enclosing_function": "", "event_count": 0,
            "propagated_event_count": 0, "direct_event_count": 0,
            "has_repeated_propagation": False, "unique_record": True,
            "cause_identity_is_heuristic": True,
            "associated_findings": [], "example_events": [],
        })
        record["event_count"] += 1
        if "via call " in message or ": via " in message:
            record["propagated_event_count"] += 1
        record["direct_event_count"] = record["event_count"] - record["propagated_event_count"]
        record["has_repeated_propagation"] = record["propagated_event_count"] > 0
        if len(record["example_events"]) < 3:
            record["example_events"].append(message)
        candidate_function = message
        if candidate_function.startswith("IRQ state "):
            candidate_function = candidate_function[len("IRQ state "):]
        delimiter = candidate_function.find(": ")
        if delimiter >= 0:
            candidate_function = candidate_function[:delimiter]
            if " at " in candidate_function:
                candidate_function = ""
        else:
            candidate_function = ""
        this_score = (1000 if "via call " in message else 0, message.count(":"))
        if key not in score or this_score < score[key]:
            score[key] = this_score
            record["enclosing_function"] = candidate_function

    records = list(grouped.values())
    cycles = report.get("interrupt_cycles", [])
    for record in records:
        path, line = record["source_file"], record["line"]
        if not path or not line:
            continue
        site = f"{path}:{line}:"
        for index, cycle in enumerate(cycles, 1):
            evidence = "\n".join(cycle.get("lock_sequence", []))
            for edge in cycle.get("edges", []):
                for field in ("from_location", "to_location"):
                    point = edge.get(field, {}).get("expansion", {})
                    if point.get("file") and point.get("line"):
                        evidence += f"\n{point['file']}:{point['line']}:{point.get('column', 0)}"
            if site in evidence:
                record["associated_findings"].append(cycle.get("finding_id", f"C-{index}"))
        if record["associated_findings"]:
            record["severity"] = "high"
            record["impact"] += "; candidate evidence overlaps this uncertainty source location"

    def grouped_counts(field: str) -> dict[str, dict[str, int]]:
        counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        for item in records:
            bucket = counts[item[field]]
            bucket[0] += item["event_count"]
            bucket[1] += 1
        return {key: {"event_count": value[0], "unique_record_count": value[1]}
                for key, value in sorted(counts.items())}

    candidate_records = [item for item in records if item["associated_findings"]]
    candidate_ids = {finding for item in candidate_records for finding in item["associated_findings"]}
    propagated = sum(item["propagated_event_count"] for item in records)
    return {
        "event_count": len(events), "unique_record_count": len(records),
        "propagated_event_count": propagated,
        "high_impact_unique_records": sum(item["severity"] == "high" for item in records),
        "lock_identity_events": sum(item["event_count"] for item in records if item["category"] == "lock_identity"),
        "interrupt_state_events": sum(item["event_count"] for item in records if item["category"] == "interrupt_state"),
        "unresolved_call_events": sum(item["event_count"] for item in records if item["category"] == "unresolved_call"),
        "candidate_affecting_unique_records": len(candidate_records),
        "affected_candidate_count": len(candidate_ids),
        "candidate_record_association_count": sum(len(item["associated_findings"]) for item in candidate_records),
        "proven_non_affecting_event_count": 0,
        "non_affecting_count_note": "No uncertainty is marked non-affecting unless that can be established; none are proven non-affecting by this classifier.",
        "by_category": grouped_counts("category"), "by_stage": grouped_counts("analysis_stage"),
        "by_function": grouped_records(records, "enclosing_function", "<unknown-function>"),
        "by_source_location": grouped_records(records, "source_location", "<unknown-location>"),
        "records": records,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: summarize_uncertainties.py REPORT_DIR OUTPUT.json", file=sys.stderr)
        return 2
    source_dir, output = map(Path, sys.argv[1:])
    try:
        all_events = 0
        all_records: dict[str, dict[str, Any]] = {}
        reports = []
        for path in sorted(source_dir.glob("*.json")):
            report = json.loads(path.read_text(encoding="utf-8"))
            if "uncertainties" not in report:
                continue
            summary = summarize(report)
            reports.append({"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                            "event_count": summary["event_count"],
                            "unique_record_count": summary["unique_record_count"],
                            "by_category": summary["by_category"], "by_stage": summary["by_stage"]})
            all_events += summary["event_count"]
            for record in summary["records"]:
                # Translation units are reported as separate analyses. Keep the
                # file in the aggregate identity; never merge across TUs.
                key = path.name + "|" + record["id"]
                all_records[key] = {"translation_unit": path.name, **record}
        categories: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        stages: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        for record in all_records.values():
            for table, name in ((categories, record["category"]), (stages, record["analysis_stage"])):
                table[name][0] += record["event_count"]
                table[name][1] += 1
        candidate_records = [r for r in all_records.values() if r["associated_findings"]]
        affected_candidate_ids = {f"{record['translation_unit']}|{finding}"
                                  for record in candidate_records
                                  for finding in record["associated_findings"]}
        result = {
            "phase": "10", "input_report_count": len(reports),
            "counting_rules": {
                "events": "Raw strings in each report's uncertainties array; unchanged and never dropped.",
                "unique_record": "Same classified category and terminal cause text including API/expression and source location after removing propagation prefixes and presentation suffixes.",
                "translation_units": "Unique IDs are kept separate per translation unit; header-derived events across TUs are not merged.",
                "propagated_event": "A raw event whose message contains an interprocedural 'via call' or IRQ summary 'via' prefix.",
            },
            "aggregate": {
                "event_count": all_events, "unique_record_count": len(all_records),
                "propagated_event_count": sum(r["propagated_event_count"] for r in all_records.values()),
                "high_impact_unique_records": sum(r["severity"] == "high" for r in all_records.values()),
                "lock_identity_events": sum(r["event_count"] for r in all_records.values() if r["category"] == "lock_identity"),
                "interrupt_state_events": sum(r["event_count"] for r in all_records.values() if r["category"] == "interrupt_state"),
                "unresolved_call_events": sum(r["event_count"] for r in all_records.values() if r["category"] == "unresolved_call"),
                "candidate_affecting_unique_records": len(candidate_records),
                "affected_candidate_count": len(affected_candidate_ids),
                "candidate_record_association_count": sum(len(r["associated_findings"]) for r in candidate_records),
                "proven_non_affecting_event_count": 0,
                "non_affecting_count_note": "None proven; the classifier does not infer that a warning is harmless.",
                "by_category": {k: {"event_count": v[0], "unique_record_count": v[1]} for k, v in sorted(categories.items())},
                "by_stage": {k: {"event_count": v[0], "unique_record_count": v[1]} for k, v in sorted(stages.items())},
                "by_function": grouped_records(all_records.values(), "enclosing_function", "<unknown-function>"),
                "by_source_location": grouped_records(all_records.values(), "source_location", "<unknown-location>"),
            },
            "translation_units": reports,
            "candidate_affecting_records": candidate_records,
            "records": list(all_records.values()),
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result["aggregate"], indent=2))
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        print(f"uncertainty summary error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
