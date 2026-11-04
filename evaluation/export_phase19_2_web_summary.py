#!/usr/bin/env python3
"""Export the compact current Linux evaluation summary for the website."""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path
from typing import Any


def read_gzip_json(path: Path) -> dict[str, Any]:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def export(root: Path) -> dict[str, Any]:
    previous = root / "evaluation/results/phase19.2"
    latest = root / "evaluation/results/phase19.3/evidence"
    before = read_gzip_json(previous / "baseline/uncertainty-summary.json.gz")["aggregate"]
    before_raw = json.loads((previous / "baseline/raw-measurements.json").read_text(encoding="utf-8"))
    if (latest / "raw-measurements.json").is_file():
        after = read_gzip_json(latest / "uncertainty-summary.json.gz")["aggregate"]
        after_raw = json.loads((latest / "raw-measurements.json").read_text(encoding="utf-8"))
        impact = read_gzip_json(latest / "uncertainty-impact.json.gz")
    else:
        after = read_gzip_json(previous / "after/uncertainty-summary.json.gz")["aggregate"]
        after_raw = json.loads((previous / "after/raw-measurements.json").read_text(encoding="utf-8"))
        impact = read_gzip_json(previous / "after/impact.json.gz")
    def metrics(summary: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any]:
        measurement = raw["aggregate"]
        counts = measurement["counts_sum_across_translation_units"]
        return {
            "uncertainty_events": summary["event_count"],
            "unique_records": summary["unique_record_count"],
            "unique_root_causes": summary["unique_root_cause_count"],
            "propagated_events": summary["propagated_event_count"],
            "high_impact_records": summary["high_impact_unique_records"],
            "paired_irq_effect_records": summary["secondary_effect_unique_record_count"],
            "unresolved_call_events": summary["unresolved_call_events"],
            "interrupt_state_events": summary["interrupt_state_events"],
            "lock_identity_events": summary["lock_identity_events"],
            "files_analyzed": measurement["files_analyzed"],
            "files_requested": measurement["files_requested"],
            "functions": counts["functions"],
            "lock_operations": counts["lock_operations"],
            "lock_acquisitions": counts["lock_acquisitions"],
            "lock_releases": counts["lock_releases"],
            "lock_dependencies": counts["lock_dependencies"],
            "interrupt_graph_edges": counts["interrupt_graph_edges"],
            "candidate_cycles": counts["interrupt_cycles"],
            "parser_diagnostics": counts["diagnostics"],
            "analysis_seconds": measurement["analysis_elapsed_seconds_sum"],
            "peak_memory_kib": measurement["peak_rss_kib_max_across_separate_runs"],
            "category_counts": summary["by_category"],
            "analyzer_sha256": raw["environment"]["analyzer_sha256"],
            "validation": {
                "kernel_object_compilation": raw["validation"]["kernel_object_compilation"],
                "objtool_object_checks": raw["validation"]["objtool_object_checks"],
                "orc_sections_present": raw["validation"]["orc_sections_present"],
                "kernel_module_link": raw["validation"]["kernel_module_link"],
                "stack_validation": raw["validation"]["stack_validation"],
            },
        }

    top_calls = sorted(
        impact["roots"],
        key=lambda item: (-item["unresolved_call_events"], item["source_file"], item["line"]),
    )[:6]
    return {
        "schema_version": 1,
        "status": "completed",
        "kernel": after_raw["kernel"],
        "subsystem": after_raw["configuration"]["subsystem"],
        "source_files": [Path(item["file"]).name for item in after_raw["translation_units"]],
        "baseline": metrics(before, before_raw),
        "after": metrics(after, after_raw),
        "per_file": [
            {
                "source_file": Path(item["file"]).name,
                "status": item["status"],
                "elapsed_seconds": item["elapsed_seconds"],
                "peak_memory_kib": item["peak_rss_kib"],
                **item["counts"],
            }
            for item in after_raw["translation_units"]
        ],
        "largest_remaining_unresolved_calls": [
            {
                "api": item["callee"],
                "source_file": Path(item["source_file"]).name,
                "line": item["line"],
                "events": item["unresolved_call_events"],
                "propagated_events": item["propagated_events"],
                "affected_functions": item["function_count"],
                "lock_held_events": item["lock_held_events"],
                "irq_effect_events": item["irq_state_effect_events"],
            }
            for item in top_calls
        ],
        "interpretation": (
            "The current model covers five exact compiler intrinsics and two source-verified Linux helpers. "
            "Other unresolved calls remain conservative. This selected five-file run produced no "
            "dependency edges or cycles; that does not establish deadlock freedom."
        ),
        "classification_note": (
            "An IRQ-state uncertainty linked to an unresolved call is a secondary effect record. "
            "It remains visible and counted, but its root_cause_id points to the underlying call record."
        ),
    }


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / "web/src/demo/phase19-2-summary.json"
    try:
        data = export(root)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    except (OSError, KeyError, json.JSONDecodeError) as error:
        print(f"Kernel evaluation summary error: {error}", file=sys.stderr)
        return 1
    print(f"Wrote current kernel evaluation summary: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
