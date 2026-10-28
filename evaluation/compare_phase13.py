#!/usr/bin/env python3
"""Create a cautious before/after comparison from preserved Phase 9/12 artifacts."""
from __future__ import annotations

import collections
import argparse
import json
import re
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "evaluation/baselines/phase9.0"
PHASE12 = ROOT / "evaluation/results/linux-v6.6.87/phase12"
CURRENT_REPORTS = PHASE12 / "post-libelf-reports"
DEFAULT_OUTPUT = ROOT / "evaluation/results/linux-v6.6.87/phase13-before-after.json"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def reports_from_tar(path: Path) -> list[dict]:
    with tarfile.open(path, "r:gz") as archive:
        names = sorted(name for name in archive.getnames()
                       if name.startswith("reports/") and name.endswith(".json"))
        return [json.load(archive.extractfile(name)) for name in names]


def summarize(measurements: dict, reports: list[dict], unique_records: int | None) -> dict:
    counts = measurements["aggregate"]["counts_sum_across_translation_units"]
    operations = collections.Counter(
        operation.get("kind", "unknown")
        for report in reports for operation in report.get("api_operations", [])
        if str(operation.get("kind", "")).startswith("lock_")
    )
    identity = collections.Counter(
        operation.get("lock", {}).get("identity_status", "missing")
        for report in reports for operation in report.get("api_operations", [])
        if str(operation.get("kind", "")).startswith("lock_")
    )
    return {
        "files": measurements["aggregate"]["files_analyzed"],
        "functions": counts["functions"],
        "lock_acquisitions": sum(value for kind, value in operations.items()
                                  if kind in ("lock_acquire", "lock_acquire_irqsave")),
        "lock_releases": sum(value for kind, value in operations.items()
                              if kind in ("lock_release", "lock_release_irqrestore")),
        "lock_operation_kinds": dict(sorted(operations.items())),
        "lock_identity_statuses": dict(sorted(identity.items())),
        "lock_dependencies": counts["lock_dependencies"],
        "interrupt_graph_edges": counts["interrupt_graph_edges"],
        "candidate_cycles": counts["interrupt_cycles"],
        "candidate_classifications": measurements["aggregate"].get("finding_category_counts_sum", {}),
        "uncertainty_events": counts["uncertainties"],
        "unique_uncertainty_records": unique_records,
        "parser_or_analysis_diagnostics": counts["diagnostics"],
        "analysis_elapsed_seconds_sum": measurements["aggregate"]["analysis_elapsed_seconds_sum"],
        "peak_rss_kib_max_across_separate_runs": measurements["aggregate"]["peak_rss_kib_max_across_separate_runs"],
        "validation": measurements.get("validation", {
            "objtool": "disabled using CONFIG_OBJTOOL= override (saved legacy schema has no stage fields)",
            "stack_validation": "not run; SKIP_STACK_VALIDATION was passed but is unsupported",
        }),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="comparison JSON path (default: checked-in Phase 13 artifact)")
    args = parser.parse_args()
    baseline = load_json(BASE / "kernel-v6.6.87-raw-measurements.json")
    current = load_json(PHASE12 / "post-libelf-full-validation-measurements.json")
    baseline_summary = load_json(ROOT / "evaluation/results/linux-v6.6.87/uncertainty-summary-phase10.json")
    current_reports = [load_json(path) for path in sorted(CURRENT_REPORTS.glob("*.json"))]
    kernel_files_before = baseline["configuration"]["requested_files"]
    kernel_files_after = current["configuration"]["requested_files"]
    if baseline["kernel"]["commit"] != current["kernel"]["commit"]:
        raise SystemExit("Cannot compare different kernel revisions")
    if kernel_files_before != kernel_files_after:
        raise SystemExit("Cannot compare different selected source files")
    if baseline["configuration"].get("config_sha256") != current["configuration"].get("config_sha256"):
        raise SystemExit("Cannot compare different generated kernel configurations")
    current_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    current_status = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()
    baseline_report = (BASE / "BASELINE.md").read_text(encoding="utf-8")
    baseline_revision = re.search(r"Repository revision: `([0-9a-f]+)`", baseline_report).group(1)
    result = {
        "schema_version": 1,
        "comparison": "saved Phase 9.0 baseline versus post-fix Phase 12 evaluation",
        "comparable_setup": {
            "kernel_revision": baseline["kernel"]["commit"],
            "source_files": [Path(file).name for file in kernel_files_before],
            "kernel_config_sha256": baseline["configuration"]["config_sha256"],
            "clang_version_before": baseline["environment"]["clang"],
            "clang_version_after": current["environment"]["clang"],
            "compilation_database_note": "The source set and config hash match; the original five-command compilation database was not preserved, so byte-for-byte compiler-flag equivalence cannot be checked. Current database has 11 commands because the composite module object was added for deferred objtool validation.",
        },
        "repository": {
            "baseline_revision": baseline_revision,
            "current_revision": current_revision,
            "current_worktree_dirty": bool(current_status),
            "baseline_analyzer_sha256": baseline["environment"]["analyzer_sha256"],
            "post_analyzer_sha256": current["environment"]["analyzer_sha256"],
        },
        "before": summarize(baseline, reports_from_tar(BASE / "kernel-v6.6.87-raw-reports.tar.gz"),
                            baseline_summary["aggregate"]["unique_record_count"]),
        "after": summarize(current, current_reports,
                           sum(report.get("uncertainty_summary", {}).get("unique_record_count", 0)
                               for report in current_reports)),
        "metrics_warning": "This is one saved run per version, not a statistical benchmark. Lower cycle and uncertainty counts do not alone prove better correctness. No labeled real-kernel ground truth supports precision or recall.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()
