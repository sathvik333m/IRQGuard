#!/usr/bin/env python3
"""Run the controlled Phase 17 fixture set and summarize archived kernel reports."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import tarfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = ROOT / "evaluation/dataset-v1.json"
DEFAULT_KERNEL_RAW = ROOT / "evaluation/results/linux-v6.6.87/phase15-raw-measurements.json"
DEFAULT_KERNEL_ARCHIVE = ROOT / "evaluation/results/linux-v6.6.87/phase15-analyzer-reports.tar.gz"
PHASE17_KERNEL_RUN = ROOT / "evaluation/results/linux-v6.6.87/phase17-rerun"


def counts(report: dict[str, Any]) -> dict[str, Any]:
    operations = report.get("api_operations", [])
    categories: dict[str, int] = {}
    for cycle in report.get("interrupt_cycles", []):
        name = cycle.get("category", "unknown")
        categories[name] = categories.get(name, 0) + 1
    summary = report.get("uncertainty_summary", {})
    by_category = summary.get("by_category", {})
    by_stage = summary.get("by_stage", {})
    return {
        "functions": len(report.get("functions", [])),
        "lock_acquisitions": sum(op.get("kind") in ("lock_acquire", "lock_acquire_irqsave") for op in operations),
        "lock_releases": sum(op.get("kind") in ("lock_release", "lock_release_irqrestore") for op in operations),
        "lock_operations": sum(str(op.get("kind", "")).startswith("lock_") for op in operations),
        "lock_dependencies": len(report.get("lock_dependencies", [])),
        "interrupt_graph_edges": len(report.get("interrupt_lock_graph", {}).get("edges", [])),
        "candidate_cycles": len(report.get("interrupt_cycles", [])),
        "cycle_categories": dict(sorted(categories.items())),
        "uncertainty_events": len(report.get("uncertainties", [])),
        "unique_uncertainty_records": summary.get("unique_record_count", len(report.get("uncertainty_records", []))),
        "uncertainty_by_category": by_category,
        "uncertainty_by_stage": by_stage,
        "diagnostics": len(report.get("diagnostics", [])),
    }


def matches_assertion(report: dict[str, Any], assertion: dict[str, Any]) -> tuple[bool, str]:
    cycles = report.get("interrupt_cycles", [])
    if "cycle_category" in assertion:
        required = assertion["cycle_category"]
        pieces = assertion.get("cycle_lock_substrings", [])
        matching = [cycle for cycle in cycles if cycle.get("category") == required and
                    all(any(piece in str(lock) for lock in cycle.get("lock_sequence", [])) for piece in pieces)]
        return bool(matching), f"matching cycle category={required}, lock markers={pieces}; found {len(matching)}"
    if "dependency_absent" in assertion:
        check = assertion["dependency_absent"]
        matches = [edge for edge in report.get("lock_dependencies", [])
                   if check["from"] in edge.get("from_lock", "") and check["to"] in edge.get("to_lock", "")
                   and ("function" not in check or edge.get("reporting_function") == check["function"])]
        return not matches, f"dependency {check['from']} -> {check['to']} absent in {check.get('function', 'any function')}; found {len(matches)}"
    if "api_operation" in assertion:
        check = assertion["api_operation"]
        matches = [op for op in report.get("api_operations", [])
                   if all(op.get(key) == value for key, value in check.items())]
        return bool(matches), f"API operation {check}; found {len(matches)}"
    if "irqsave_pair" in assertion:
        function = assertion["irqsave_pair"]["function"]
        acquire = [op for op in report.get("api_operations", [])
                   if op.get("caller") == function and op.get("api") == "spin_lock_irqsave"
                   and op.get("kind") == "lock_acquire_irqsave"]
        release = [op for op in report.get("api_operations", [])
                   if op.get("caller") == function and op.get("api") == "spin_unlock_irqrestore"
                   and op.get("kind") == "lock_release_irqrestore"]
        pairs = [(left, right) for left in acquire for right in release
                 if left.get("state_identity") and left.get("state_identity") == right.get("state_identity")
                 and left.get("lock", {}).get("identity_template") == right.get("lock", {}).get("identity_template")]
        return bool(pairs), f"matching irqsave/irqrestore lock and flags identities in {function}; found {len(pairs)}"
    if assertion.get("has_lock_operations"):
        matches = [op for op in report.get("api_operations", []) if str(op.get("kind", "")).startswith("lock_")]
        return bool(matches), f"lock operations present; found {len(matches)}"
    return False, "unsupported or empty assertion"


def analyze(analyzer: Path, source: Path, timeout: int) -> tuple[dict[str, Any], float, int | None, str]:
    started = time.perf_counter()
    command = [str(analyzer), "analyze", "--source", str(source), "--format", "json"]
    peak_rss_kib = None
    timer = shutil.which("/usr/bin/time")
    if timer:
        with tempfile.NamedTemporaryFile(prefix="irqguard-p17-rss-", delete=False) as file:
            measurement_path = Path(file.name)
        try:
            process = subprocess.run([timer, "-f", "%M", "-o", str(measurement_path), *command],
                                     cwd=ROOT, capture_output=True, text=True, timeout=timeout, check=False)
            try:
                peak_rss_kib = int(measurement_path.read_text(encoding="ascii").strip())
            except (OSError, ValueError):
                pass
        finally:
            measurement_path.unlink(missing_ok=True)
    else:
        process = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=timeout, check=False)
    elapsed = time.perf_counter() - started
    if process.returncode != 0:
        raise RuntimeError(f"analyzer failed for {source} ({process.returncode}): {process.stderr.strip()}")
    return json.loads(process.stdout), elapsed, peak_rss_kib, process.stderr


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analyzer", type=Path, default=ROOT / "build/deadlock-analyzer")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=ROOT / "evaluation/results/phase17")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--kernel-raw", type=Path, default=None,
                        help="raw measurements JSON; defaults to the fresh Phase 17 run if present, otherwise Phase 15 archive")
    parser.add_argument("--kernel-archive", type=Path, default=DEFAULT_KERNEL_ARCHIVE)
    parser.add_argument("--kernel-reports-dir", type=Path, default=None,
                        help="per-file report directory; defaults to the fresh Phase 17 run if present")
    parser.add_argument("--kernel", type=Path, default=ROOT / "third_party/linux-v6.6.87",
                        help="optional pinned checkout to validate; this does not build or modify it")
    args = parser.parse_args()
    analyzer = args.analyzer.resolve()
    dataset_path = args.dataset.resolve()
    output = args.output.resolve()
    if not analyzer.is_file() or not analyzer.stat().st_mode & 0o111:
        raise SystemExit(f"Analyzer is missing or not executable: {analyzer}")
    if output.exists() and any(output.iterdir()):
        raise SystemExit(f"Refusing to overwrite non-empty output directory: {output}; choose a new --output")
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    kernel_raw_path = (args.kernel_raw.resolve() if args.kernel_raw else
                       (PHASE17_KERNEL_RUN / "raw-measurements.json" if (PHASE17_KERNEL_RUN / "raw-measurements.json").is_file()
                        else DEFAULT_KERNEL_RAW))
    kernel_reports_dir = (args.kernel_reports_dir.resolve() if args.kernel_reports_dir else
                          (PHASE17_KERNEL_RUN / "reports" if (PHASE17_KERNEL_RUN / "reports").is_dir() else None))

    pin = dataset.get("kernel_pin", {})
    kernel_path = args.kernel.resolve()
    if kernel_path.is_dir() and (kernel_path / ".git").exists():
        pin_check = subprocess.run(["git", "-C", str(kernel_path), "rev-parse", "HEAD"],
                                   capture_output=True, text=True, check=False)
        actual_commit = pin_check.stdout.strip() if pin_check.returncode == 0 else None
        kernel_pin_validation = {"status": "matched" if actual_commit == pin.get("commit") else "mismatch",
                                 "path": str(kernel_path), "expected_commit": pin.get("commit"),
                                 "actual_commit": actual_commit}
    else:
        kernel_pin_validation = {"status": "checkout_unavailable_archived_reports_only",
                                 "path": str(kernel_path), "expected_commit": pin.get("commit"),
                                 "actual_commit": None}

    source_reports: dict[str, dict[str, Any]] = {}
    source_metrics: dict[str, dict[str, Any]] = {}
    results: list[dict[str, Any]] = []
    for case in dataset["cases"]:
        if case["group"] == "real_kernel_exploratory":
            continue
        source = (ROOT / case["source"]).resolve()
        key = str(source)
        if key not in source_reports:
            report, elapsed, peak_rss, stderr = analyze(analyzer, source, args.timeout)
            source_reports[key] = report
            source_metrics[key] = {"elapsed_seconds": round(elapsed, 6), "peak_rss_kib": peak_rss,
                                   "stderr": stderr}
        report = source_reports[key]
        passed, reason = matches_assertion(report, case["assert"] or {})
        results.append({"case_id": case["id"], "group": case["group"], "label_status": "controlled_expected_behavior",
                        "status": "passed" if passed else "failed", "assertion": reason,
                        "source": case["source"], "measurements": counts(report)})

    source_map = {str((ROOT / item["source"]).resolve()): item["source"]
                  for item in dataset["cases"] if item["group"] != "real_kernel_exploratory"}
    for full_path, report in source_reports.items():
        safe_name = source_map[full_path].replace("/", "__")
        (output / f"fixture-{safe_name}.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    kernel_entries: list[dict[str, Any]] = []
    raw_measurements = json.loads(kernel_raw_path.read_text(encoding="utf-8")) if kernel_raw_path.is_file() else None
    if raw_measurements and raw_measurements.get("kernel", {}).get("commit") != pin.get("commit"):
        raise SystemExit(f"Kernel raw measurements do not match dataset pin {pin.get('commit')}: {kernel_raw_path}")
    archive_sha256 = None
    raw_sha256 = None
    import hashlib
    if args.kernel_archive.is_file() and kernel_reports_dir is None:
        archive_sha256 = hashlib.sha256(args.kernel_archive.read_bytes()).hexdigest()
    if kernel_raw_path.is_file():
        raw_sha256 = hashlib.sha256(kernel_raw_path.read_bytes()).hexdigest()
        shutil.copyfile(kernel_raw_path, output / "kernel-raw-measurements.json")
    if kernel_reports_dir and kernel_reports_dir.is_dir():
        report_paths = {path.stem + ".json": path for path in kernel_reports_dir.glob("*.json")}
        for case in dataset["cases"]:
            if case["group"] != "real_kernel_exploratory":
                continue
            filename = Path(case["source"]).stem + ".json"
            report_path = report_paths.get(filename)
            if not report_path:
                kernel_entries.append({"case_id": case["id"], "group": case["group"],
                                       "label_status": "unlabeled", "status": "kernel_report_missing"})
                continue
            report = json.loads(report_path.read_text(encoding="utf-8"))
            per_file = next((unit for unit in (raw_measurements or {}).get("translation_units", [])
                             if Path(unit.get("file", "")).name == Path(case["source"]).name), {})
            kernel_entries.append({"case_id": case["id"], "group": case["group"],
                                   "label_status": "unlabeled_exploratory", "status": "fresh_phase17_observation",
                                   "source": case["source"], "kernel_revision": case["revision"],
                                   "report_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
                                   "measurements": counts(report),
                                   "elapsed_seconds": per_file.get("elapsed_seconds"),
                                   "peak_rss_kib": per_file.get("peak_rss_kib"),
                                   "validation_note": "Fresh Phase 17 report; exploratory, not a ground-truth label."})
    elif args.kernel_archive.is_file():
        with tarfile.open(args.kernel_archive, "r:gz") as archive:
            members = {Path(name).name: name for name in archive.getnames() if name.endswith(".json")}
            for case in dataset["cases"]:
                if case["group"] != "real_kernel_exploratory":
                    continue
                filename = Path(case["source"]).stem + ".json"
                member = members.get(filename)
                if not member:
                    kernel_entries.append({"case_id": case["id"], "group": case["group"],
                                           "label_status": "unlabeled", "status": "archived_report_missing"})
                    continue
                report = json.load(archive.extractfile(member))
                per_file = next((unit for unit in (raw_measurements or {}).get("translation_units", [])
                                 if Path(unit.get("file", "")).name == Path(case["source"]).name), {})
                kernel_entries.append({"case_id": case["id"], "group": case["group"],
                                       "label_status": "unlabeled_exploratory", "status": "archived_observation",
                                       "source": case["source"], "kernel_revision": case["revision"],
                                       "report_archive_member": member, "measurements": counts(report),
                                       "elapsed_seconds": per_file.get("elapsed_seconds"),
                                       "peak_rss_kib": per_file.get("peak_rss_kib"),
                                       "validation_note": "Archived analyzer output; not a ground-truth label and not rerun by this command."})
    elif any(case["group"] == "real_kernel_exploratory" for case in dataset["cases"]):
        kernel_entries.append({"label_status": "unlabeled_exploratory", "status": "archived_reports_unavailable"})

    passed = sum(row["status"] == "passed" for row in results)
    failed = sum(row["status"] == "failed" for row in results)
    import hashlib
    summary = {
        "schema_version": 1, "dataset_id": dataset["dataset_id"], "analyzer": str(analyzer),
        "analyzer_sha256": hashlib.sha256(analyzer.read_bytes()).hexdigest(),
        "dataset_sha256": hashlib.sha256(dataset_path.read_bytes()).hexdigest(),
        "kernel_pin": dataset.get("kernel_pin"),
        "kernel_pin_validation": kernel_pin_validation,
        "archived_kernel_environment": (raw_measurements or {}).get("environment"),
        "kernel_evidence_sha256": {"reports_archive": archive_sha256, "raw_measurements": raw_sha256},
        "kernel_measurements_source": str(kernel_raw_path),
        "kernel_configuration": (raw_measurements or {}).get("configuration"),
        "kernel_validation": (raw_measurements or {}).get("validation"),
        "controlled_fixture_cases": results, "controlled_fixture_passed": passed,
        "controlled_fixture_failed": failed,
        "fixture_source_runs": {source_map[path]: metrics for path, metrics in source_metrics.items()},
        "real_kernel_cases": kernel_entries,
        "real_kernel_aggregate": (raw_measurements or {}).get("aggregate"),
        "ground_truth": {"independent_bug_cases": 0, "precision": None, "recall": None,
                         "reason": "The dataset contains no independently verified Linux deadlock labels."},
        "notes": ["Fixture assertion counts are controlled regression outcomes, not statistical accuracy metrics.",
                  "Kernel rows summarize preserved Phase 15 reports and are exploratory; they are not reanalysis results.",
                  "Fixture peak RSS is measured per analyzer process with GNU time when available; otherwise it is null."],
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    lines = ["# IRQGuard Phase 17 Evaluation Run", "", f"Dataset: `{dataset['dataset_id']}`",
             f"Analyzer SHA-256: `{summary['analyzer_sha256']}`", "",
             f"Kernel checkout validation: `{kernel_pin_validation['status']}` ({kernel_pin_validation['path']}).", "",
             f"Controlled fixture assertions: **{passed} passed, {failed} failed**.", "",
             "## Controlled fixtures", "", "| Case | Group | Result | Measured cycles | Dependencies | Uncertainty events |",
             "|---|---|---:|---:|---:|---:|"]
    for row in results:
        m = row["measurements"]
        lines.append(f"| `{row['case_id']}` | {row['group']} | {row['status']} | {m['candidate_cycles']} | {m['lock_dependencies']} | {m['uncertainty_events']} |")
    lines += ["", "Fixture analyzer process measurements (one run per distinct source):", "",
              "| Source | Time | Peak RSS |", "|---|---:|---:|"]
    for source, measurement in sorted(source_metrics.items(), key=lambda entry: source_map[entry[0]]):
        rss = f"{measurement['peak_rss_kib']} KiB" if measurement["peak_rss_kib"] is not None else "not measured"
        lines.append(f"| `{source_map[source]}` | {measurement['elapsed_seconds']} s | {rss} |")
    lines += ["", "## Linux v6.6.87 exploratory observations", "",
              ("These values come from the fresh Phase 17 kernel run." if kernel_reports_dir else
               "These values come from preserved Phase 15 report files and measurements; this runner does not rerun kernel analysis."), "",
              "| Case | Status | Functions | Lock ops | Dependencies | Cycles | Uncertainty events | Time | Peak RSS |",
              "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for row in kernel_entries:
        m = row.get("measurements", {})
        lines.append(f"| `{row.get('case_id', '—')}` | {row['status']} (unlabeled) | {m.get('functions', '—')} | {m.get('lock_operations', '—')} | {m.get('lock_dependencies', '—')} | {m.get('candidate_cycles', '—')} | {m.get('uncertainty_events', '—')} | {row.get('elapsed_seconds', '—')} s | {row.get('peak_rss_kib', '—')} KiB |")
    lines += ["", "## Interpretation", "", "No precision or recall is calculated: the real-kernel cases have no independent labels. A zero cycle count means only that this bounded analyzer/report contained no cycle for that translation unit. It does not show that the code is deadlock-free. See `docs/phase17-evaluation.md` for tool-model differences, provenance and reproduction steps.", ""]
    if raw_measurements:
        totals = raw_measurements.get("aggregate", {}).get("counts_sum_across_translation_units", {})
        unique_sum = sum(row.get("measurements", {}).get("unique_uncertainty_records", 0)
                         for row in kernel_entries)
        lines += ["## Linux aggregate", "",
                  f"The {('Phase 17 fresh run' if kernel_reports_dir else 'Phase 15 archive')} records {raw_measurements.get('aggregate', {}).get('files_analyzed', '—')}/{raw_measurements.get('aggregate', {}).get('files_requested', '—')} files analyzed; {totals.get('functions', '—')} functions; {totals.get('lock_operations', '—')} lock operations; {totals.get('lock_dependencies', '—')} dependencies; {totals.get('interrupt_cycles', '—')} cycles; {totals.get('uncertainties', '—')} uncertainty events; {totals.get('diagnostics', '—')} diagnostics. Unique uncertainty records summed across translation-unit reports (not cross-file deduplicated): {unique_sum}.", "",
                  "Uncertainty by category (event / per-report unique-record sums):", ""]
        category_counts: dict[str, list[int]] = {}
        for row in kernel_entries:
            for category, values in row.get("measurements", {}).get("uncertainty_by_category", {}).items():
                totals_for_category = category_counts.setdefault(category, [0, 0])
                totals_for_category[0] += values.get("event_count", 0)
                totals_for_category[1] += values.get("unique_record_count", 0)
        for category, (events, unique) in sorted(category_counts.items()):
            lines.append(f"- `{category}`: {events} / {unique}")
        validation = raw_measurements.get("validation", {})
        environment = raw_measurements.get("environment", {})
        configuration = raw_measurements.get("configuration", {})
        lines += ["", "Build and environment evidence:", "",
                  f"- Kernel commit: `{raw_measurements.get('kernel', {}).get('checkout_commit', 'unknown')}`",
                  f"- Clang: {environment.get('clang', 'unknown')}",
                  f"- Kbuild config SHA-256: `{configuration.get('config_sha256', 'unknown')}`",
                  f"- Selected object compilation: `{validation.get('kernel_object_compilation', 'unknown')}`",
                  f"- Objtool object checks: `{validation.get('objtool_object_checks', 'unknown')}`",
                  f"- ORC sections present: `{validation.get('orc_sections_present', 'unknown')}`",
                  f"- Final module link: `{validation.get('kernel_module_link', 'unknown')}`",
                  f"- Separate stack validation: `{validation.get('stack_validation', 'unknown')}`", ""]
    (output / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"Phase 17: {passed} controlled cases passed, {failed} failed; wrote {output}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
