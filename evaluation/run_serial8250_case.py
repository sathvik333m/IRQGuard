#!/usr/bin/env python3
"""Build and analyze the paired Linux 8250 lock-order case without source edits."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CASE_ROOT = ROOT / "historical-case"
SOURCE_REL = Path("drivers/tty/serial/8250/8250_port.c")
OBJECT_REL = Path("drivers/tty/serial/8250/8250_port.o")
TU_DIR = Path("drivers/tty/serial/8250")
PINS = {
    "affected": "547bbf7d214fff2d29bc885ea7efea0fbc127791",
    "fixed": "730037c3ee57f892e6df019bc88d417a5944737c",
}
COMPDB_GENERATOR_PIN = "03c4d26933d54556a89379db5923ae9e474569e8"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(command: list[str], cwd: Path, log: Path) -> float:
    started = time.perf_counter()
    with log.open("a", encoding="utf-8") as stream:
        stream.write("$ " + " ".join(command) + "\n")
        stream.flush()
        result = subprocess.run(command, cwd=cwd, stdout=stream,
                                stderr=subprocess.STDOUT, check=False)
    elapsed = time.perf_counter() - started
    if result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}); see {log}")
    return elapsed


def output(command: list[str], cwd: Path) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()


def verify_source(name: str) -> tuple[Path, str]:
    source = (CASE_ROOT / "serial8250" / name).resolve()
    revision = output(["git", "rev-parse", "HEAD"], source)
    if revision != PINS[name]:
        raise RuntimeError(f"{name} source pin mismatch: expected {PINS[name]}, got {revision}")
    if output(["git", "status", "--porcelain", "--untracked-files=no"], source):
        raise RuntimeError(f"tracked source files are modified in {source}")
    if not (source / SOURCE_REL).is_file():
        raise RuntimeError(f"missing source file: {source / SOURCE_REL}")
    return source, revision


def counts(report: dict[str, Any]) -> dict[str, Any]:
    operations = [op for op in report.get("api_operations", [])
                  if str(op.get("kind", "")).startswith("lock_")]
    categories: dict[str, int] = {}
    for cycle in report.get("interrupt_cycles", []):
        category = str(cycle.get("category", "unknown"))
        categories[category] = categories.get(category, 0) + 1
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
    affected = reports["affected"]
    external_calls = [call for call in affected.get("calls", [])
                      if call.get("callee") == "disable_irq_nosync"
                      and call.get("resolution") == "external"]
    uncertainties = [str(item) for item in affected.get("uncertainties", [])]
    unresolved_irq_lock = any("disable_irq_nosync" in item and "unsupported" in item for item in uncertainties)
    has_cycle = any(reports[name].get("interrupt_cycles") for name in ("affected", "fixed"))
    return {
        "classification": "miss" if not has_cycle else "partial_match",
        "affected_lockdep_pattern_reported": False,
        "fixed_lockdep_pattern_reported": False,
        "affected_external_disable_irq_call_seen": bool(external_calls),
        "unsupported_disable_irq_api_uncertainty": unresolved_irq_lock,
        "explanation": (
            "The upstream lockdep report documents a dependency involving port->lock, the IRQ "
            "descriptor lock, printk/console locking, and a hard-IRQ error path. IRQGuard extracts "
            "the local port lock and reports disable_irq_nosync as an unresolved external call, "
            "but has no summary for the IRQ descriptor lock and analyzes only this translation "
            "unit. It therefore emits no dependency or cycle in either revision. This is a miss, "
            "with the key unsupported effect visible as uncertainty."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analyzer", type=Path, default=ROOT / "build/deadlock-analyzer")
    parser.add_argument("--llvm", type=Path, default=Path("/usr/lib/llvm-20/bin"))
    parser.add_argument("--output", type=Path,
                        default=CASE_ROOT / "results" / "serial8250" / f"run-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    args = parser.parse_args()
    analyzer = args.analyzer.resolve()
    llvm = args.llvm.resolve()
    output_dir = args.output.resolve()
    if output_dir.exists():
        parser.error(f"output already exists; choose a new path to preserve evidence: {output_dir}")
    if not analyzer.is_file() or not os.access(analyzer, os.X_OK):
        parser.error(f"analyzer is not executable: {analyzer}")
    generator_source = (CASE_ROOT / "affected").resolve()
    generator_pin = output(["git", "rev-parse", "HEAD"], generator_source)
    if generator_pin != COMPDB_GENERATOR_PIN:
        parser.error(f"pinned Kbuild database generator source mismatch: {generator_pin}")
    generator = generator_source / "scripts/clang-tools/gen_compile_commands.py"
    if not generator.is_file():
        parser.error(f"missing pinned compilation database generator: {generator}")

    output_dir.mkdir(parents=True)
    result: dict[str, Any] = {
        "schema_version": 1,
        "case_id": "linux-8250-startup-lock-order-2020",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "pins": PINS,
        "compilation_database_generator_revision": generator_pin,
        "source_file": str(SOURCE_REL),
        "analyzer": {"path": str(analyzer), "sha256": sha256(analyzer)},
        "environment": {
            "python": sys.version.split()[0],
            "clang": output([str(llvm / "clang"), "--version"], ROOT).splitlines()[0],
            "gcc": output(["gcc", "--version"], ROOT).splitlines()[0],
            "make": output(["make", "--version"], ROOT).splitlines()[0],
            "architecture": "x86_64",
            "defconfig": "x86_64_defconfig",
            "kernel_release": "5.8.0 source revision; Clang 20 and GCC 13 host tools",
            "build_validation": "one C object compiled; objtool/ORC validation skipped; no kernel link",
            "build_overrides": [
                "CC=/usr/lib/llvm-20/bin/clang",
                "HOSTLDFLAGS=-fuse-ld=bfd",
                "CONFIG_SYSTEM_TRUSTED_KEYRING=n for Kbuild host-tool selection (OpenSSL headers unavailable)",
                "CONFIG_STACK_VALIDATION= and CONFIG_UNWINDER_ORC= with SKIP_STACK_VALIDATION=1",
            ],
            "build_limitation": "The 5.8 objtool host tool fails under GCC 13 with -Werror=use-after-free; source-object compilation proceeds with stack validation explicitly omitted.",
        },
        "results": {},
        "limitations": [
            "The analysis is limited to 8250_port.c; it does not include genirq or console implementation translation units.",
            "disable_irq_nosync is unresolved and its lock effects are not summarized.",
            "The official source carries a lockdep circular-dependency report; this run does not reproduce the runtime schedule.",
            "No accuracy metric is inferred from this case.",
        ],
    }

    expected_config: bytes | None = None
    for name in ("affected", "fixed"):
        source, revision = verify_source(name)
        build = output_dir / f"{name}-kbuild"
        build.mkdir()
        log = output_dir / f"{name}.log"
        report_path = output_dir / f"{name}.json"
        if name == "fixed":
            (build / ".config").write_bytes(expected_config or b"")
        make_base = ["make", "-C", str(source), f"O={build}", "ARCH=x86_64",
                     f"CC={llvm / 'clang'}", "HOSTCC=gcc", "HOSTCXX=g++",
                     "HOSTLD=/usr/bin/ld", "HOSTLDFLAGS=-fuse-ld=bfd", "LD=/usr/bin/ld"]
        build_seconds = 0.0
        if name == "affected":
            build_seconds += run(make_base + ["x86_64_defconfig"], ROOT, log)
            build_seconds += run(make_base + ["olddefconfig"], ROOT, log)
            expected_config = (build / ".config").read_bytes()
        else:
            build_seconds += run(make_base + ["olddefconfig"], ROOT, log)
            if (build / ".config").read_bytes() != expected_config:
                raise RuntimeError("affected/fixed Kbuild configuration differs")

        object_command = make_base + [
            "CONFIG_SYSTEM_TRUSTED_KEYRING=n", "CONFIG_STACK_VALIDATION=",
            "CONFIG_UNWINDER_ORC=", "SKIP_STACK_VALIDATION=1", str(OBJECT_REL),
        ]
        build_seconds += run(object_command, ROOT, log)
        compile_db = build / "compile_commands.json"
        run([sys.executable, str(generator), "-d", str(build), "-o", str(compile_db),
             str(build / TU_DIR)], ROOT, log)
        entries = json.loads(compile_db.read_text(encoding="utf-8"))
        if len(entries) != 1 or Path(entries[0]["file"]).resolve() != (source / SOURCE_REL).resolve():
            raise RuntimeError(f"unexpected compilation database for {name}")

        started = time.perf_counter()
        run([str(analyzer), "analyze", "--source", str(source / SOURCE_REL),
             "--compile-commands", str(build), "--format", "json", "--output", str(report_path)],
            ROOT, log)
        analysis_seconds = time.perf_counter() - started
        report = json.loads(report_path.read_text(encoding="utf-8"))
        result["results"][name] = {
            "revision": revision,
            "source_sha256": sha256(source / SOURCE_REL),
            "config_sha256": sha256(build / ".config"),
            "compile_commands_sha256": sha256(compile_db),
            "object_build_and_setup_seconds": round(build_seconds, 3),
            "analysis_seconds": round(analysis_seconds, 3),
            "measurements": counts(report),
            "report": report_path.name,
            "build_log": log.name,
        }

    reports = {name: json.loads((output_dir / item["report"]).read_text(encoding="utf-8"))
               for name, item in result["results"].items()}
    result["validation"] = validate_pair(reports)
    (output_dir / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({name: item["measurements"] for name, item in result["results"].items()}, indent=2))
    print(f"Wrote {output_dir / 'summary.json'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError, RuntimeError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
