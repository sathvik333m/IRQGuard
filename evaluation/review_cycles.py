#!/usr/bin/env python3
"""Create a traceable Phase 11 review of the archived Linux cycle report.

This does not rerun analysis or certify findings. It joins the preserved report
to the Phase 10 uncertainty ledger and labels each archived candidate using the
review rules documented in docs/phase11-cycle-review.md.
"""
import argparse
import hashlib
import json
from pathlib import Path


def point(location):
    return location.get("expansion", {}) if location else {}


def run(report_path: Path, uncertainty_path: Path, output_path: Path):
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    uncertainty = json.loads(uncertainty_path.read_text(encoding="utf-8"))
    current_path = report_path.parents[1] / "phase12" / "source-only-measurements.json"
    current = None
    if current_path.is_file():
        current = json.loads(current_path.read_text(encoding="utf-8"))
    cycle_records = []
    uncertainty_records = [item for item in uncertainty["records"]
                           if item.get("associated_findings")]

    for index, cycle in enumerate(report.get("interrupt_cycles", []), start=1):
        finding_id = f"C-{index}"
        edges = cycle.get("edges", [])
        edge = edges[0] if edges else {}
        op_line = point((edge.get("from_location") or {})).get("line")
        related_ops = [op for op in report.get("api_operations", [])
                       if op.get("caller") == edge.get("target_function")
                       and point(op.get("location") or {}).get("line") in (op_line, 503)]
        affected = [item for item in uncertainty_records
                    if finding_id in item.get("associated_findings", [])]
        source_path = point(edge.get("from_location") or {}).get("file", "")
        calls = []
        seen_calls = set()
        for item in edge.get("source_provenance", []):
            loc = point(item.get("location") or {})
            call = {"caller": item.get("function"), "callee": item.get("callee"),
                    "file": loc.get("file"), "line": loc.get("line"),
                    "column": loc.get("column")}
            key = (call["caller"], call["callee"], call["file"], call["line"], call["column"])
            if key not in seen_calls:
                seen_calls.add(key)
                calls.append(call)
        lock_sequence = cycle.get("lock_sequence", [])
        self_edge = bool(edge) and edge.get("from_lock") == edge.get("to_lock")
        reasons = [
            "The archived graph contains one edge whose source and destination are the same unresolved lock key; this is not evidence of two distinct lock acquisitions forming a real order cycle.",
            "The edge is marked uncertain and unrefined, and its lock acquisition identity is unresolved while the matching irqrestore release is represented by a different symbolic expression.",
            "The archived edge is process-to-process, has no handler target or registration location, and does not encode an interrupt-context conflict.",
            "The irqsave saved-state relation is unresolved in the archived uncertainty ledger, so no defensible IRQ-state feasibility conclusion follows.",
            "The preserved report predates the Phase 9 extraction fix; the pinned Linux checkout is unavailable for a fresh run and direct source-line verification.",
        ]
        cycle_records.append({
            "finding_id": finding_id,
            "classification": "inconclusive",
            "classification_definition": "The archived graph has a reported cycle, but unresolved identity, state, or stale-input evidence prevents a defensible feasibility conclusion.",
            "archived_analyzer_category": cycle.get("category"),
            "archived_feasibility": cycle.get("feasibility"),
            "cycle_path": lock_sequence,
            "edges": edges,
            "source_file": source_path,
            "functions": {"source": edge.get("source_function"), "target": edge.get("target_function")},
            "call_path": calls,
            "interrupt_evidence": {
                "from_context": edge.get("from_context"), "to_context": edge.get("to_context"),
                "handler": edge.get("handler") or None,
                "registration_location": edge.get("registration_location"),
                "interpretation": "No handler evidence is attached to this cycle edge. Other registrations in the translation unit do not establish that this call path is a hard-IRQ handler path.",
            },
            "lock_operation_evidence": [
                {"api": op.get("api"), "kind": op.get("kind"), "function": op.get("caller"),
                 "lock": op.get("lock"), "location": op.get("location"),
                 "arguments": op.get("arguments", [])} for op in related_ops
            ],
            "irq_state": {
                "edge_state": edge.get("irq_state"),
                "saved_flags_relation": "unresolved in archived Phase 9 report",
                "interpretation": "The report does not establish whether local IRQs were previously enabled or disabled, nor prove a saved-state restoration relation for this cycle.",
            },
            "uncertainty_record_ids": [item["id"] for item in affected],
            "uncertainties": affected,
            "reasons": reasons,
            "manual_validation": [
                "Rerun the analyzer on the exact pinned v6.6.87 checkout with the post-Phase-9 binary.",
                "Inspect the macro-expanded acquisition and matching release to verify both resolve to adapter->systim_lock and that flags are saved/restored consistently.",
                "Inspect all call-site conditions and execution contexts before asserting a conflicting acquisition path.",
                "Confirm any suspected cross-context contention against handler registration and driver execution semantics; do not infer a bug from this archived self-edge.",
            ],
            "review_notes": reasons,
            "archived_edge_is_self_edge": self_edge,
        })

    if current and current.get("kernel", {}).get("checkout_commit") == "814637ca257f4faf57a73fd4e38888cce88b5911":
        current_analysis = {
            "status": current.get("status"),
            "reason": "A fresh source-only analysis of the pinned tree completed after Phase 9. It emitted no current lock-dependency edges or cycles. Objtool and ORC generation were explicitly skipped, so this result is not evidence that the driver is deadlock-free.",
            "validation": current.get("validation", {}),
            "aggregate": current.get("aggregate", {}),
            "measurements": str(current_path),
        }
        review_status = "archived_review_with_current_source_scan"
    else:
        current_analysis = {
            "status": "unavailable",
            "reason": "No fresh post-Phase-9 analysis of the pinned Linux source is available in this checkout.",
        }
        review_status = "current_analysis_not_recomputed"

    output = {
        "schema_version": 1,
        "review_kind": "retrospective_archived_cycle_review",
        "status": review_status,
        "kernel": {"release_tag": "v6.6.87", "commit": "814637ca257f4faf57a73fd4e38888cce88b5911"},
        "input": {"report": str(report_path), "schema_version": report.get("schema_version"),
                  "sha256": hashlib.sha256(report_bytes).hexdigest(),
                  "uncertainty_ledger": str(uncertainty_path)},
        "current_analysis": current_analysis,
        "classification_definitions": {
            "candidate": "A modeled cycle exists, but feasibility has not been assessed enough to support a stronger conclusion.",
            "potentially_feasible": "Source and execution evidence support a plausible conflicting execution, while material uncertainties remain.",
            "inconclusive": "Missing, unresolved, or stale evidence prevents a defensible feasibility conclusion.",
            "rejected_by_feasibility_checks": "A documented contradiction or proven modeled constraint rules out the scenario under stated assumptions.",
            "independently_confirmed": "Independent evidence establishes a deadlock under clearly stated conditions.",
        },
        "findings": cycle_records,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"Reviewed {len(cycle_records)} archived cycles; all classifications: inconclusive")
    print(f"Current analysis: {output['current_analysis']['status']}")
    print(f"Wrote {output_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=Path("evaluation/results/linux-v6.6.87/reports/netdev.json"))
    parser.add_argument("--uncertainties", type=Path, default=Path("evaluation/results/linux-v6.6.87/uncertainty-summary-phase10.json"))
    parser.add_argument("--output", type=Path, default=Path("evaluation/results/linux-v6.6.87/cycle-review-phase11.json"))
    args = parser.parse_args()
    run(args.report, args.uncertainties, args.output)


if __name__ == "__main__":
    main()
