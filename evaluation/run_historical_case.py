#!/usr/bin/env python3
"""Rebuild and compare the pinned MIPS GIC bug and fix without editing sources."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CASE_ROOT = ROOT / "historical-case"
PINS = {
    "affected": "03c4d26933d54556a89379db5923ae9e474569e8",
    "fixed": "1bae25dcc6beb8b874f23601d2efa142ac4f9f36",
}
INTRODUCING_COMMIT = "322a9063876890895cb8308cc6f59de312e8aad5"
SOURCE = Path("drivers/irqchip/irq-mips-gic.c")
OBJECT = Path("drivers/irqchip/irq-mips-gic.o")
TU_DIR = Path("drivers/irqchip")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(command: list[str], cwd: Path, log: Path, env: dict[str, str] | None = None) -> float:
    started = time.perf_counter()
    with log.open("a", encoding="utf-8") as stream:
        stream.write("$ " + " ".join(command) + "\n")
        stream.flush()
        result = subprocess.run(command, cwd=cwd, env=env, stdout=stream,
                                stderr=subprocess.STDOUT, check=False)
    elapsed = time.perf_counter() - started
    if result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}); see {log}")
    return elapsed


def output(command: list[str], cwd: Path) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()


def report_counts(report: dict[str, Any]) -> dict[str, Any]:
    operations = [op for op in report.get("api_operations", [])
                  if str(op.get("kind", "")).startswith("lock_")]
    categories: dict[str, int] = {}
    for cycle in report.get("interrupt_cycles", []):
        key = str(cycle.get("category", "unknown"))
        categories[key] = categories.get(key, 0) + 1
    return {
        "functions": len(report.get("functions", [])),
        "calls": len(report.get("calls", [])),
        "lock_operations": len(operations),
        "lock_acquisitions": sum(op.get("kind") in {"lock_acquire", "lock_acquire_irqsave"} for op in operations),
        "lock_releases": sum(op.get("kind") in {"lock_release", "lock_release_irqrestore"} for op in operations),
        "dependencies": len(report.get("lock_dependencies", [])),
        "cycles": len(report.get("interrupt_cycles", [])),
        "cycle_categories": categories,
        "uncertainty_events": len(report.get("uncertainties", [])),
        "unique_uncertainty_records": len(report.get("uncertainty_records", [])),
        "parser_diagnostics": len(report.get("diagnostics", [])),
    }


def validate_pair(reports: dict[str, dict[str, Any]]) -> dict[str, Any]:
    affected_cycles = reports["affected"].get("interrupt_cycles", [])
    matching_edges = [
        edge
        for cycle in affected_cycles
        for edge in cycle.get("edges", [])
        if edge.get("source_function") == "gic_set_affinity"
        and edge.get("target_function") == "gic_set_type"
        and edge.get("from_lock") == edge.get("to_lock")
    ]
    fixed_cycles = reports["fixed"].get("interrupt_cycles", [])
    guard_ops = [
        op for op in reports["fixed"].get("api_operations", [])
        if op.get("caller") == "gic_set_type" and str(op.get("kind", "")).startswith("lock_")
    ]
    return {
        "classification": "partial_match" if matching_edges and not fixed_cycles and not guard_ops else "miss",
        "affected_recursive_lock_pattern_detected": bool(matching_edges),
        "fixed_revision_has_no_reported_cycle": not bool(fixed_cycles),
        "fixed_guard_lock_operation_extracted": bool(guard_ops),
        "explanation": (
            "The affected source produces the upstream-described gic_set_affinity -> gic_set_type "
            "same-lock edge and cycle. The cycle is classified inconclusive because its summary "
            "is uncertain. The fixed revision removes that recursive helper call, but its "
            "guard(raw_spinlock_irqsave) acquisition is not extracted, so this is a partial "
            "match rather than evidence of complete fixed-version lock coverage."
        ),
    }


def verify_checkout(name: str, source: Path) -> str:
    actual = output(["git", "rev-parse", "HEAD"], source)
    if actual != PINS[name]:
        raise RuntimeError(f"{name} source pin mismatch: expected {PINS[name]}, got {actual}")
    changes = output(["git", "status", "--porcelain", "--untracked-files=no"], source)
    if changes:
        raise RuntimeError(f"{name} source checkout has tracked modifications")
    if not (source / SOURCE).is_file():
        raise RuntimeError(f"missing source file: {source / SOURCE}")
    return actual


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analyzer", type=Path, default=ROOT / "build/deadlock-analyzer")
    parser.add_argument("--source-root", type=Path, default=CASE_ROOT,
                        help="directory containing affected/ and fixed/ worktrees")
    parser.add_argument("--output", type=Path,
                        default=CASE_ROOT / "results" / f"run-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    parser.add_argument("--llvm", type=Path, default=Path("/usr/lib/llvm-20/bin"))
    args = parser.parse_args()

    source_root = args.source_root.resolve()
    analyzer = args.analyzer.resolve()
    output_dir = args.output.resolve()
    llvm = args.llvm.resolve()
    if output_dir.exists():
        parser.error(f"output already exists; choose a new path to preserve evidence: {output_dir}")
    if not analyzer.is_file() or not os.access(analyzer, os.X_OK):
        parser.error(f"analyzer is not executable: {analyzer}")
    output_dir.mkdir(parents=True)

    env = {
        **os.environ,
        "ARCH": "mips",
        "LLVM": str(llvm) + "/",
        "HOSTCC": "gcc",
        "HOSTCXX": "g++",
        "HOSTLD": "/usr/bin/ld",
        "HOSTLDFLAGS": "-fuse-ld=bfd",
        "LD": "/usr/bin/ld",
    }
    result: dict[str, Any] = {
        "schema_version": 1,
        "case_id": "linux-mips-gic-recursive-lock-2026",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "pins": PINS,
        "introducing_commit": INTRODUCING_COMMIT,
        "source_file": str(SOURCE),
        "analyzer": {"path": str(analyzer), "sha256": sha256(analyzer)},
        "environment": {
            "python": sys.version.split()[0],
            "clang": output([str(llvm / "clang"), "--version"], ROOT).splitlines()[0],
            "gcc": output(["gcc", "--version"], ROOT).splitlines()[0],
            "make": output(["make", "--version"], ROOT).splitlines()[0],
            "architecture": "mips",
            "defconfig": "malta_defconfig",
            "host_linker_override": "HOSTLDFLAGS=-fuse-ld=bfd; avoids missing lld-20",
        },
        "results": {},
        "limitations": [
            "This is one translation unit, not a whole-kernel interprocedural analysis.",
            "The fixed revision uses guard(raw_spinlock_irqsave); current extraction does not emit that guard as a lock operation.",
            "The analyzer reports high uncertainty and classifies the affected cycle as inconclusive.",
            "A source-level candidate and upstream fix do not establish runtime reproduction in this environment.",
        ],
    }

    expected_config: bytes | None = None
    for name in ("affected", "fixed"):
        source = (source_root / name).resolve()
        revision = verify_checkout(name, source)
        build = output_dir / f"{name}-kbuild"
        report_path = output_dir / f"{name}.json"
        log = output_dir / f"{name}.log"
        build.mkdir()
        if name == "fixed":
            (build / ".config").write_bytes(expected_config or b"")

        make_base = ["make", "-C", str(source), f"O={build}", "ARCH=mips",
                     f"LLVM={llvm}/", "HOSTCC=gcc", "HOSTCXX=g++",
                     "HOSTLD=/usr/bin/ld", "HOSTLDFLAGS=-fuse-ld=bfd", "LD=/usr/bin/ld"]
        setup_seconds = 0.0
        if name == "affected":
            setup_seconds += run(make_base + ["malta_defconfig"], ROOT, log, env)
            expected_config = (build / ".config").read_bytes()
        setup_seconds += run(make_base + ["olddefconfig"], ROOT, log, env)
        setup_seconds += run(make_base + ["prepare"], ROOT, log, env)
        setup_seconds += run(make_base + [str(OBJECT)], ROOT, log, env)

        compile_db = build / "compile_commands.json"
        generator = source / "scripts/clang-tools/gen_compile_commands.py"
        run([sys.executable, str(generator), "-d", str(build), "-o", str(compile_db),
             str(build / TU_DIR)], ROOT, log)
        entries = json.loads(compile_db.read_text(encoding="utf-8"))
        if len(entries) != 1 or Path(entries[0]["file"]).resolve() != (source / SOURCE).resolve():
            raise RuntimeError(f"unexpected compilation database for {name}: {entries}")

        started = time.perf_counter()
        run([str(analyzer), "analyze", "--source", str(source / SOURCE),
             "--compile-commands", str(build), "--format", "json", "--output", str(report_path)],
            ROOT, log)
        analysis_seconds = time.perf_counter() - started
        report = json.loads(report_path.read_text(encoding="utf-8"))
        result["results"][name] = {
            "revision": revision,
            "source_sha256": sha256(source / SOURCE),
            "config_sha256": sha256(build / ".config"),
            "compile_commands_sha256": sha256(compile_db),
            "setup_and_object_build_seconds": round(setup_seconds, 3),
            "analysis_seconds": round(analysis_seconds, 3),
            "measurements": report_counts(report),
            "report": report_path.name,
            "build_log": log.name,
        }

    result_path = output_dir / "summary.json"
    reports = {
        name: json.loads((output_dir / data["report"]).read_text(encoding="utf-8"))
        for name, data in result["results"].items()
    }
    result["validation"] = validate_pair(reports)
    result_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({name: data["measurements"] for name, data in result["results"].items()}, indent=2))
    print(f"Wrote {result_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError, RuntimeError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
