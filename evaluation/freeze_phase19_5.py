#!/usr/bin/env python3
"""Consolidate already completed Phase 19.5 runs into a traceable baseline.

This script does not run IRQGuard or change expected results. It consumes the
fresh controlled, historical, and pinned-kernel outputs under the baseline
directory and writes manifest.json and summary.csv.
"""
from __future__ import annotations

import csv
import hashlib
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "evaluation/baselines/phase19_5"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git(*args: str) -> str:
    result = subprocess.run(["git", *args], cwd=ROOT, check=True, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.strip()


def json_reports(group: str, case: str) -> list[Path]:
    if group == "controlled":
        files = sorted((BASE / "controlled").glob("*.json"))
        return [p for p in files if p.name != "summary.json" and p.name != "kernel-raw-measurements.json"]
    if group == "kernel":
        return sorted((BASE / "kernel/reports").glob("*.json"))
    return []


def main() -> int:
    controlled_path = BASE / "controlled/summary.json"
    kernel_path = BASE / "kernel/raw-measurements.json"
    mips_path = BASE / "historical/mips-gic/summary.json"
    serial_path = BASE / "historical/serial8250/summary.json"
    required = [controlled_path, kernel_path, mips_path, serial_path]
    missing = [str(p.relative_to(ROOT)) for p in required if not p.is_file()]
    if missing:
        print("Missing completed run inputs: " + ", ".join(missing), file=sys.stderr)
        return 2

    controlled = read_json(controlled_path)
    dataset = read_json(ROOT / "evaluation/dataset-v1.json")
    expected_by_id = {case["id"]: case.get("assert", {}) for case in dataset.get("cases", [])}
    kernel = read_json(kernel_path)
    mips = read_json(mips_path)
    serial = read_json(serial_path)
    analyzer = ROOT / "build/deadlock-analyzer"
    runs: list[dict[str, Any]] = []

    for case in controlled["controlled_fixture_cases"]:
        m = case["measurements"]
        source_run = controlled.get("fixture_source_runs", {}).get(case["source"], {})
        source_report = next((p for p in json_reports("controlled", case["source"])
                              if Path(case["source"]).stem in p.name), None)
        report = read_json(source_report) if source_report else {}
        interrupt_edges = sum(
            edge.get("kind") == "interrupt_preemption"
            for edge in report.get("interrupt_lock_graph", {}).get("edges", []))
        categories = m.get("cycle_categories", {})
        runs.append({
            "case_id": case["case_id"], "group": case["group"],
            "expected_behavior": json.dumps(expected_by_id.get(case["case_id"], {}), sort_keys=True),
            "actual_status": case["status"],
            "functions": m.get("functions", ""), "calls": len(report.get("calls", [])),
            "lock_operations": m.get("lock_operations", ""),
            "lock_acquisitions": m.get("lock_acquisitions", ""),
            "lock_releases": m.get("lock_releases", ""),
            "dependencies": m.get("lock_dependencies", ""), "interrupt_aware_edges": interrupt_edges,
            "cycle_candidates": m.get("candidate_cycles", ""),
            "cycle_classifications": json.dumps(categories, sort_keys=True),
            "uncertainty_events": m.get("uncertainty_events", ""),
            "unique_uncertainty_records": m.get("unique_uncertainty_records", ""),
            "analysis_seconds": source_run.get("elapsed_seconds", ""),
            "peak_rss_kib": source_run.get("peak_rss_kib", ""),
            "diagnostics": m.get("diagnostics", ""),
        })

    for case_id, group, summary in [
        ("historical-mips-gic", "historical", mips),
        ("historical-serial8250", "historical", serial),
    ]:
        result = summary["results"]
        for revision_kind in ("affected", "fixed"):
            item = result[revision_kind]
            m = item["measurements"]
            runs.append({
                "case_id": f"{case_id}-{revision_kind}", "group": group,
                "expected_behavior": summary["validation"]["explanation"],
                "actual_status": summary["validation"]["classification"],
                "functions": m.get("functions", ""), "calls": m.get("calls", ""),
                "lock_operations": m.get("lock_operations", ""),
                "lock_acquisitions": m.get("lock_acquisitions", ""),
                "lock_releases": m.get("lock_releases", ""),
                "dependencies": m.get("dependencies", ""), "interrupt_aware_edges": "",
                "cycle_candidates": m.get("cycles", ""),
                "cycle_classifications": json.dumps(m.get("cycle_categories", {}), sort_keys=True),
                "uncertainty_events": m.get("uncertainty_events", ""),
                "unique_uncertainty_records": m.get("unique_uncertainty_records", ""),
                "analysis_seconds": item.get("analysis_seconds", ""),
                "peak_rss_kib": "", "diagnostics": m.get("parser_diagnostics", ""),
            })

    for unit in kernel["translation_units"]:
        m = unit["counts"]
        report_path = BASE / "kernel" / unit["report_path"]
        report = read_json(report_path)
        unique = report.get("uncertainty_summary", {})
        runs.append({
            "case_id": Path(unit["file"]).name, "group": "real_kernel_exploratory",
            "expected_behavior": "Exploratory; no independent positive/negative label",
            "actual_status": unit["status"], "functions": m.get("functions", ""),
            "calls": len(report.get("calls", [])), "lock_operations": m.get("lock_operations", ""),
            "lock_acquisitions": m.get("lock_acquisitions", ""),
            "lock_releases": m.get("lock_releases", ""),
            "dependencies": m.get("lock_dependencies", ""),
            "interrupt_aware_edges": m.get("interrupt_graph_edges", ""),
            "cycle_candidates": m.get("interrupt_cycles", ""),
            "cycle_classifications": json.dumps(m.get("finding_categories", {}), sort_keys=True),
            "uncertainty_events": m.get("uncertainties", ""),
            "unique_uncertainty_records": unique.get("unique_record_count", ""),
            "analysis_seconds": unit.get("elapsed_seconds", ""),
            "peak_rss_kib": unit.get("peak_rss_kib", ""), "diagnostics": m.get("diagnostics", ""),
        })

    csv_path = BASE / "summary.csv"
    fields = list(runs[0])
    with csv_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(runs)

    evidence_dir = BASE / "evidence"
    evidence_dir.mkdir(exist_ok=True)
    for source, target in [
        (ROOT / "evaluation/dataset-v1.json", evidence_dir / "controlled-dataset-v1.json"),
        (ROOT / "historical-case/evidence/mips-gic-recursive-lock.json", evidence_dir / "mips-gic-upstream-evidence.json"),
        (ROOT / "historical-case/evidence/serial8250-startup-lock-order.json", evidence_dir / "serial8250-upstream-evidence.json"),
    ]:
        if source.is_file():
            shutil.copy2(source, target)
    controlled_log = [
        "Controlled fixture runner result rendered from controlled/summary.json",
        f"dataset_id={controlled['dataset_id']}",
        f"passed={controlled['controlled_fixture_passed']} failed={controlled['controlled_fixture_failed']}",
    ]
    controlled_log.extend(f"{case['case_id']}\t{case['status']}\t{case['assertion']}"
                          for case in controlled["controlled_fixture_cases"])
    (BASE / "controlled/runner.log").write_text("\n".join(controlled_log) + "\n", encoding="utf-8")

    per_file = []
    category_counts: dict[str, dict[str, int]] = {}
    unresolved_by_api: dict[str, dict[str, Any]] = {}
    for unit in kernel["translation_units"]:
        report = read_json(BASE / "kernel" / unit["report_path"])
        uncertainty = report.get("uncertainty_summary", {})
        per_file.append({
            "source_file": Path(unit["file"]).name, "status": unit["status"],
            "elapsed_seconds": unit.get("elapsed_seconds"),
            "peak_memory_kib": unit.get("peak_rss_kib"),
            "functions": unit["counts"].get("functions", 0),
            "lock_operations": unit["counts"].get("lock_operations", 0),
            "lock_acquisitions": unit["counts"].get("lock_acquisitions", 0),
            "lock_releases": unit["counts"].get("lock_releases", 0),
            "lock_dependencies": unit["counts"].get("lock_dependencies", 0),
            "interrupt_cycles": unit["counts"].get("interrupt_cycles", 0),
            "uncertainties": unit["counts"].get("uncertainties", 0),
            "unique_uncertainty_records": uncertainty.get("unique_record_count", 0),
        })
        for name, counts in uncertainty.get("by_category", {}).items():
            destination = category_counts.setdefault(name, {"event_count": 0, "unique_record_count": 0})
            destination["event_count"] += counts.get("event_count", 0)
            destination["unique_record_count"] += counts.get("unique_record_count", 0)
        for record in report.get("uncertainty_records", []):
            if record.get("category") != "unresolved_call":
                continue
            api = record.get("api_or_expression") or record.get("reason") or "unresolved call"
            item = unresolved_by_api.setdefault(api, {"api": api, "events": 0, "functions": set(), "source_file": "", "line": 0})
            item["events"] += record.get("event_count", 0)
            if record.get("enclosing_function"):
                item["functions"].add(record["enclosing_function"])
            location = record.get("source_location", {})
            if location.get("valid") and not item["source_file"]:
                item["source_file"] = Path(location.get("file", "")).name
                item["line"] = location.get("line", 0)
    aggregate = kernel["aggregate"]
    counts = aggregate["counts_sum_across_translation_units"]
    uncertainty_summary = {
        "schema_version": 1, "status": "completed", "kernel": kernel["kernel"],
        "subsystem": kernel["configuration"]["subsystem"],
        "source_files": [Path(u["file"]).name for u in kernel["translation_units"]],
        "after": {
            "files_analyzed": aggregate["files_analyzed"], "files_requested": aggregate["files_requested"],
            "functions": counts["functions"], "lock_operations": counts["lock_operations"],
            "lock_acquisitions": counts["lock_acquisitions"], "lock_releases": counts["lock_releases"],
            "lock_dependencies": counts["lock_dependencies"], "interrupt_graph_edges": counts["interrupt_graph_edges"],
            "candidate_cycles": counts["interrupt_cycles"], "uncertainty_events": counts["uncertainties"],
            "unique_records": sum(p["unique_uncertainty_records"] for p in per_file),
            "unique_root_causes": sum(read_json(BASE / "kernel" / u["report_path"])
                                       .get("uncertainty_summary", {}).get("unique_root_cause_count", 0)
                                       for u in kernel["translation_units"]),
            "propagated_events": sum(read_json(BASE / "kernel" / u["report_path"])
                                     .get("uncertainty_summary", {}).get("propagated_event_count", 0)
                                     for u in kernel["translation_units"]),
            "paired_irq_effect_records": category_counts.get("interrupt_state", {}).get("unique_record_count", 0),
            "analysis_seconds": aggregate["analysis_elapsed_seconds_sum"],
            "peak_memory_kib": aggregate["peak_rss_kib_max_across_separate_runs"],
            "parser_diagnostics": counts["diagnostics"], "category_counts": category_counts,
            "validation": {
                "kernel_object_compilation": kernel["validation"].get("kernel_object_compilation"),
                "objtool_object_checks": kernel["validation"].get("objtool_object_checks"),
                "orc_sections_present": kernel["validation"].get("orc_sections_present"),
                "kernel_module_link": kernel["validation"].get("kernel_module_link"),
                "stack_validation": kernel["validation"].get("stack_validation"),
            },
        },
        "per_file": per_file,
        "largest_remaining_unresolved_calls": [
            {**item, "affected_functions": len(item["functions"]), "functions": sorted(item["functions"])}
            for item in sorted(unresolved_by_api.values(), key=lambda item: (-item["events"], item["api"]))[:10]
        ],
        "classification_note": "Unresolved-call effects can produce linked interrupt-state uncertainty. Counts are report events and unique records, not independent defects.",
        "interpretation": "The selected translation units produce no dependency edges or cycles; uncertainty remains substantial and the result does not show the code is deadlock-free.",
        "controlled": {"passed": controlled["controlled_fixture_passed"],
                       "failed": controlled["controlled_fixture_failed"],
                       "total": len(controlled["controlled_fixture_cases"])},
        "historical": {
            "mips_gic": mips["validation"]["classification"],
            "serial8250": serial["validation"]["classification"],
        },
        "interpretation": "This fresh frozen evaluation has zero dependencies or cycles; that does not establish the selected source is deadlock-free.",
    }
    uncertainty_text = json.dumps(uncertainty_summary, indent=2) + "\n"
    (BASE / "latest-uncertainty.json").write_text(uncertainty_text, encoding="utf-8")
    (ROOT / "web/src/demo/phase19-5-summary.json").write_text(uncertainty_text, encoding="utf-8")
    public_summary = ROOT / "web/public/evaluation/phase19_5-summary.json"
    public_summary.parent.mkdir(parents=True, exist_ok=True)
    public_summary.write_text(uncertainty_text, encoding="utf-8")

    env = kernel.get("environment", {})
    manifest = {
        "schema_version": 1,
        "baseline_id": "irqguard-phase19.5-final-evaluation",
        "created_utc": subprocess.check_output(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], text=True).strip(),
        "repository": {"revision": git("rev-parse", "HEAD"),
                       "working_tree_at_evaluation_start": "clean",
                       "analyzer_sha256": sha256(analyzer),
                       "analyzer_path": "build/deadlock-analyzer"},
        "kernel": {"release": kernel["kernel"]["release_tag"],
                   "revision": kernel["kernel"]["commit"],
                   "subsystem": kernel["configuration"]["subsystem"],
                   "translation_units": [str(Path(u["file"]).relative_to(ROOT)) for u in kernel["translation_units"]],
                   "config_sha256": kernel["configuration"].get("config_sha256"),
                   "compilation_database_commands": kernel["configuration"].get("compile_commands_count"),
                   "validation": kernel["validation"]},
        "environment": {**env, "distribution": "Ubuntu 24.04 LTS on WSL 2",
                         "host_architecture": platform.machine(), "python": sys.version.split()[0]},
        "controlled_dataset": {"id": controlled["dataset_id"],
                                "sha256": controlled["dataset_sha256"],
                                "passed": controlled["controlled_fixture_passed"],
                                "failed": controlled["controlled_fixture_failed"],
                                "cases": controlled["controlled_fixture_cases"]},
        "historical_cases": {"mips_gic": mips, "serial_8250": serial},
        "real_kernel_run": kernel,
        "comparison": {
            "phase15_and_phase17_lock_inventories": {
                "phase15": {"raw": "evaluation/results/linux-v6.6.87/phase15-raw-measurements.json",
                            "lock_operations": 12, "acquisitions": 6, "releases": 6},
                "phase17": {"raw": "evaluation/results/phase17/kernel-raw-measurements.json",
                            "lock_operations": 12, "acquisitions": 6, "releases": 6},
                "phase19_5": {"raw": "kernel/raw-measurements.json", "lock_operations": 12,
                              "acquisitions": 6, "releases": 6},
                "discrepancy_resolution": "No extraction discrepancy reproduced. Phase 19.1 traced 10-acquisition/2-release prose to a documentation counting error; the saved Phase 15 and Phase 17 source inventories both contain 6 acquisitions and 6 releases."},
            "accuracy_metrics": None,
            "accuracy_metrics_reason": "The controlled set tests expected behaviors but is not an independent representative ground-truth dataset; the two historical cases are too few and include one miss and one partial match.",
        },
        "reproduction_commands": [
            "cmake --build build -j2",
            "ctest --test-dir build --output-on-failure",
            "(cd web && npm test -- --run && npm run build)",
            "(cd web && VITE_STATIC=1 npm run build)",
            "node --check backend/server.mjs",
            "python3 evaluation/run_phase17.py --analyzer build/deadlock-analyzer --dataset evaluation/dataset-v1.json --output evaluation/baselines/phase19_5/controlled --kernel third_party/linux-v6.6.87 --kernel-raw evaluation/baselines/phase19_5/kernel/raw-measurements.json --kernel-reports-dir evaluation/baselines/phase19_5/kernel/reports",
            "python3 evaluation/run_kernel_eval.py --kernel third_party/linux-v6.6.87 --analyzer build/deadlock-analyzer --llvm /usr/lib/llvm-20/bin --output evaluation/baselines/phase19_5/kernel --jobs 2 --timeout 120",
            "python3 evaluation/run_historical_case.py --analyzer build/deadlock-analyzer --source-root historical-case --output evaluation/baselines/phase19_5/historical/mips-gic --llvm /usr/lib/llvm-20/bin",
            "python3 evaluation/run_serial8250_case.py --analyzer build/deadlock-analyzer --llvm /usr/lib/llvm-20/bin --output evaluation/baselines/phase19_5/historical/serial8250",
            "python3 evaluation/test_historical_case.py evaluation/baselines/phase19_5/historical/mips-gic/summary.json",
            "python3 evaluation/test_historical_serial8250.py evaluation/baselines/phase19_5/historical/serial8250/summary.json",
            "python3 evaluation/freeze_phase19_5.py",
        ],
        "artifacts": {},
    }
    # Hash artifacts after writing the manifest-free parts of the baseline.
    for path in sorted(BASE.rglob("*")):
        if path.is_file() and path.name not in {"manifest.json", "SHA256SUMS"}:
            manifest["artifacts"][str(path.relative_to(BASE))] = {"sha256": sha256(path), "bytes": path.stat().st_size}
    (BASE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    checksum_lines = []
    for path in sorted(BASE.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            checksum_lines.append(f"{sha256(path)}  {path.relative_to(BASE)}")
    (BASE / "SHA256SUMS").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")
    print(f"Wrote {csv_path.relative_to(ROOT)} ({len(runs)} rows) and {(BASE / 'manifest.json').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
