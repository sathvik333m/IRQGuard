#!/usr/bin/env python3
"""Build and analyze a bounded e1000e selection from one pinned Linux tree.

The script never edits tracked kernel source files. Kbuild output, configuration,
compile commands, raw analyzer reports, timings, and logs go under --output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

EXPECTED_COMMIT = "814637ca257f4faf57a73fd4e38888cce88b5911"
SUBSYSTEM = Path("drivers/net/ethernet/intel/e1000e")
SOURCE_FILES = ("netdev.c", "ethtool.c", "ich8lan.c", "phy.c", "nvm.c")


def run(command: list[str], cwd: Path, log: Path, timeout: int = 1800,
        env: dict[str, str] | None = None) -> tuple[int, float]:
    started = time.perf_counter()
    with log.open("a", encoding="utf-8") as output:
        output.write("$ " + " ".join(command) + "\n")
        output.flush()
        try:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=output,
                                    stderr=subprocess.STDOUT, timeout=timeout, check=False)
            return result.returncode, time.perf_counter() - started
        except subprocess.TimeoutExpired:
            output.write(f"TIMEOUT after {timeout} seconds\n")
            return 124, time.perf_counter() - started


def output_of(command: list[str], cwd: Path) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()


def parse_peak_kib(text: str) -> int | None:
    match = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", text)
    return int(match.group(1)) if match else None


def report_counts(report: dict[str, Any]) -> dict[str, Any]:
    categories: dict[str, int] = {}
    for item in report.get("interrupt_cycles", []):
        key = item.get("category", "unknown")
        categories[key] = categories.get(key, 0) + 1
    return {
        "functions": len(report.get("functions", [])),
        "lock_operations": sum(str(item.get("kind", "")).startswith("lock_")
                                for item in report.get("api_operations", [])),
        "lock_dependencies": len(report.get("lock_dependencies", [])),
        "interrupt_graph_edges": len(report.get("interrupt_lock_graph", {}).get("edges", [])),
        "interrupt_graph_nodes": len(report.get("interrupt_lock_graph", {}).get("nodes", [])),
        "interrupt_cycles": len(report.get("interrupt_cycles", [])),
        "finding_categories": dict(sorted(categories.items())),
        "uncertainties": len(report.get("uncertainties", [])),
        "diagnostics": len(report.get("diagnostics", [])),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kernel", type=Path, required=True, help="clean checkout of the pinned kernel revision")
    parser.add_argument("--analyzer", type=Path, default=Path("build/deadlock-analyzer"))
    parser.add_argument("--output", type=Path, default=Path("evaluation/results/linux-v6.6.87"))
    parser.add_argument("--llvm", type=Path, default=Path("/usr/lib/llvm-20/bin"), help="LLVM tool directory passed to Kbuild")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=300, help="per-translation-unit analyzer timeout")
    args = parser.parse_args()

    kernel = args.kernel.resolve()
    analyzer = args.analyzer.resolve()
    output = args.output.resolve()
    build = output / "kbuild"
    reports_dir = output / "reports"
    output.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)
    log = output / "build.log"
    log.write_text("", encoding="utf-8")
    summary_path = output / "raw-measurements.json"
    result: dict[str, Any] = {
        "evaluation_schema": 1,
        "kernel": {"release_tag": "v6.6.87", "commit": EXPECTED_COMMIT},
        "analyzer": {"path": str(analyzer)},
        "configuration": {
            "architecture": "x86_64", "compiler_mode": "Clang via Kbuild LLVM=",
            "config_base": "x86_64_defconfig", "driver_config": "CONFIG_E1000E=m",
            "kbuild_variables": {"ARCH": "x86_64", "LLVM": str(args.llvm.resolve()) + "/", "LD": "/usr/bin/ld"},
            "build_limitations": ["The selected object build overrides CONFIG_OBJTOOL and SKIP_STACK_VALIDATION=1 because lld-20 and libelf-dev are absent; Clang source compilation and Kbuild flags remain enabled, while objtool validation is skipped."],
            "subsystem": str(SUBSYSTEM), "requested_files": [str(SUBSYSTEM / item) for item in SOURCE_FILES],
        },
        "setup_steps": [], "translation_units": [],
        "aggregate": {"files_requested": len(SOURCE_FILES), "files_analyzed": 0, "files_skipped_or_failed": 0},
        "comparison_note": "Mode counts are derived projections from a single schema-v3 report; they are not separately configured analyzer runs.",
        "precision_recall": None,
        "status": "not_started",
    }

    try:
        commit = output_of(["git", "rev-parse", "HEAD"], kernel)
        result["kernel"]["checkout_commit"] = commit
        result["kernel"]["git_describe"] = output_of(["git", "describe", "--tags", "--exact-match", "HEAD"], kernel)
        result["environment"] = {
            "python": sys.version.split()[0], "kernel_host": os.uname().release,
            "gcc": output_of(["gcc", "--version"], kernel).splitlines()[0],
            "clang": output_of([str(args.llvm / "clang"), "--version"], kernel).splitlines()[0],
            "make": output_of(["make", "--version"], kernel).splitlines()[0],
            "time": output_of(["/usr/bin/time", "--version"], kernel).splitlines()[0],
            "cmake": output_of(["cmake", "--version"], kernel).splitlines()[0],
            "analyzer_sha256": hashlib.sha256(analyzer.read_bytes()).hexdigest() if analyzer.is_file() else None,
        }
    except (OSError, subprocess.CalledProcessError) as error:
        result["status"] = "blocked_environment"
        result["blocker"] = f"Could not inspect the source or toolchain: {error}"
        summary_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(result["blocker"], file=sys.stderr)
        return 2

    if commit != EXPECTED_COMMIT:
        result["status"] = "wrong_kernel_revision"
        result["blocker"] = f"Expected {EXPECTED_COMMIT}, got {commit}"
        summary_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(result["blocker"], file=sys.stderr)
        return 2
    if not analyzer.is_file() or not os.access(analyzer, os.X_OK):
        result["status"] = "blocked_analyzer_missing"
        result["blocker"] = f"Analyzer is not executable: {analyzer}"
        summary_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(result["blocker"], file=sys.stderr)
        return 2

    env = os.environ.copy()
    make_vars = ["ARCH=x86_64", f"LLVM={args.llvm.resolve()}/", "LD=/usr/bin/ld"]
    selected_objects = [f"{SUBSYSTEM}/{Path(name).stem}.o" for name in SOURCE_FILES]
    steps = [
        ["make", *make_vars, f"O={build}", "x86_64_defconfig"],
        [str(kernel / "scripts/config"), "--file", str(build / ".config"), "--module", "E1000E"],
        ["make", *make_vars, f"O={build}", "olddefconfig"],
        ["make", *make_vars, "CONFIG_OBJTOOL=", f"O={build}", "prepare0"],
        ["make", *make_vars, "CONFIG_OBJTOOL=", "SKIP_STACK_VALIDATION=1", f"O={build}", "-j" + str(args.jobs), *selected_objects],
    ]
    for command in steps:
        code, elapsed = run(command, kernel, log, env=env)
        result["setup_steps"].append({"command": command, "exit_code": code, "elapsed_seconds": round(elapsed, 3)})
        if code:
            result["status"] = "kernel_setup_failed"
            result["blocker"] = f"Kernel setup command failed ({code}); see {log}"
            summary_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            print(result["blocker"], file=sys.stderr)
            return 1

    object_paths = [build / item for item in selected_objects]
    missing_objects = [str(item) for item in object_paths if not item.is_file()]
    result["configuration"]["missing_object_files"] = missing_objects
    database_script = kernel / "scripts/clang-tools/gen_compile_commands.py"
    db = build / "compile_commands.json"
    command = [sys.executable, str(database_script), "-d", str(build), "-o", str(db), str(build / SUBSYSTEM)]
    code, elapsed = run(command, kernel, log, env=env)
    result["setup_steps"].append({"command": command, "exit_code": code, "elapsed_seconds": round(elapsed, 3)})
    if code or not db.is_file():
        result["status"] = "compilation_database_failed"
        result["blocker"] = f"Could not generate compile_commands.json from selected Kbuild .cmd records; see {log}"
        summary_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(result["blocker"], file=sys.stderr)
        return 1

    try:
        commands = json.loads(db.read_text(encoding="utf-8"))
        configured = {str(Path(item["file"]).resolve()): item for item in commands}
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        result["status"] = "compilation_database_invalid"
        result["blocker"] = str(error)
        summary_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return 1
    result["configuration"]["compile_commands_count"] = len(commands)
    config_bytes = (build / ".config").read_bytes()
    result["configuration"]["config_sha256"] = hashlib.sha256(config_bytes).hexdigest()

    total_elapsed = 0.0
    max_peak_kib = 0
    for name in SOURCE_FILES:
        source = kernel / SUBSYSTEM / name
        item: dict[str, Any] = {"file": str(source), "status": "skipped", "skip_reason": None}
        if not source.is_file():
            item["skip_reason"] = "requested source file is absent at the pinned revision"
        elif str(source.resolve()) not in configured:
            item["skip_reason"] = "source did not receive a compilation command from the selected Kbuild output"
        else:
            report_path = reports_dir / f"{source.stem}.json"
            stderr_path = reports_dir / f"{source.stem}.stderr.txt"
            time_path = reports_dir / f"{source.stem}.time.txt"
            command = ["/usr/bin/time", "-v", "-o", str(time_path), str(analyzer), "analyze", "--source", str(source), "--compile-commands", str(build), "--format", "json", "--output", str(report_path)]
            started = time.perf_counter()
            with stderr_path.open("w", encoding="utf-8") as errors:
                try:
                    process = subprocess.run(command, cwd=kernel, stdout=subprocess.DEVNULL,
                                             stderr=errors, timeout=args.timeout, check=False)
                    code = process.returncode
                except subprocess.TimeoutExpired:
                    code = 124
                    errors.write(f"Analyzer timed out after {args.timeout} seconds\n")
            duration = time.perf_counter() - started
            total_elapsed += duration
            time_text = time_path.read_text(encoding="utf-8", errors="replace") if time_path.exists() else ""
            peak = parse_peak_kib(time_text)
            if peak is not None:
                max_peak_kib = max(max_peak_kib, peak)
            item.update({"command": command, "exit_code": code, "elapsed_seconds": round(duration, 3),
                         "peak_rss_kib": peak,
                         "report_path": str(report_path.relative_to(output)),
                         "stderr_path": str(stderr_path.relative_to(output)),
                         "time_path": str(time_path.relative_to(output))})
            if code == 0 and report_path.is_file():
                try:
                    report = json.loads(report_path.read_text(encoding="utf-8"))
                    if report.get("schema_version") != 3:
                        raise ValueError(f"unexpected report schema {report.get('schema_version')}")
                    item["status"] = "analyzed"
                    item["counts"] = report_counts(report)
                    from summarize import summarize
                    item["mode_views"] = summarize(report)
                except (OSError, json.JSONDecodeError, ValueError, TypeError) as error:
                    item["status"] = "failed"
                    item["skip_reason"] = f"analyzer emitted unreadable or unsupported JSON: {error}"
            else:
                item["status"] = "failed"
                item["skip_reason"] = "parser/analyzer exited nonzero or timed out; see stderr file"
        result["translation_units"].append(item)

    analyzed = [item for item in result["translation_units"] if item["status"] == "analyzed"]
    result["aggregate"] = {
        "files_requested": len(SOURCE_FILES), "files_analyzed": len(analyzed),
        "files_skipped_or_failed": len(SOURCE_FILES) - len(analyzed),
        "analysis_elapsed_seconds_sum": round(total_elapsed, 3),
        "peak_rss_kib_max_across_separate_runs": max_peak_kib or None,
        "counts_sum_across_translation_units": {
            key: sum(item["counts"][key] for item in analyzed)
            for key in ("functions", "lock_operations", "lock_dependencies", "interrupt_graph_edges", "interrupt_graph_nodes", "interrupt_cycles", "uncertainties", "diagnostics")
        },
        "finding_category_counts_sum": {},
    }
    for item in analyzed:
        for category, count in item["counts"]["finding_categories"].items():
            result["aggregate"]["finding_category_counts_sum"][category] = result["aggregate"]["finding_category_counts_sum"].get(category, 0) + count
    result["status"] = "completed_with_skips" if len(analyzed) < len(SOURCE_FILES) else "completed"
    summary_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["aggregate"], indent=2))
    return 0 if analyzed else 1


if __name__ == "__main__":
    raise SystemExit(main())
