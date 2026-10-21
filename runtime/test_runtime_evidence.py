#!/usr/bin/env python3
"""Integration checks for runtime tracing, watchdog handling and comparison."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runtime_evidence as evidence  # noqa: E402


demo = Path(sys.argv[1]).resolve()
analyzer = Path(sys.argv[2]).resolve()
root = Path(sys.argv[3]).resolve()


def run(scenario: str, directory: Path) -> dict:
    return evidence.run_scenario(demo, scenario, directory / f"{scenario}.jsonl", 1.25)


with tempfile.TemporaryDirectory(prefix="irqguard-runtime-test-") as temporary:
    directory = Path(temporary)

    safe = run("safe", directory)
    assert safe["termination"] == "completed"
    assert safe["observed_contention_count"] == 0
    assert safe["terminal_wait_for_cycles"] == []

    opposite = run("opposite-order", directory)
    orders = {(edge["from_lock"], edge["to_lock"]) for edge in opposite["observed_lock_orders"]}
    assert {("A", "B"), ("B", "A")} <= orders
    assert opposite["terminal_wait_for_cycles"] == []
    assert opposite["deadlock_reproduction"] == "not_confirmed"

    contention = run("contention", directory)
    assert contention["termination"] == "completed"
    assert contention["observed_contention_count"] > 0
    assert contention["terminal_wait_for_cycles"] == []

    deadlock = run("deadlock", directory)
    assert deadlock["termination"] == "watchdog_timeout"
    assert deadlock["terminal_wait_for_cycles"], "expected a persistent userspace wait-for cycle"
    assert deadlock["deadlock_reproduction"] == "watchdog_timeout_with_persistent_wait_for_cycle"

    static_only = run("static-only", directory)
    assert static_only["termination"] == "completed"
    reverse_only = run("reverse-only", directory)

    source = root / "runtime/fixtures/lock_orders.c"
    api_config = root / "runtime/apis.json"
    parsed = subprocess.run(
        [str(analyzer), "analyze", "--source", str(source), "--api-config", str(api_config),
         "--clang-arg", f"-I{root / 'runtime'}", "--format", "json"],
        capture_output=True, text=True, timeout=20, check=False,
    )
    assert parsed.returncode == 0, parsed.stderr
    report = json.loads(parsed.stdout)
    assert report.get("interrupt_cycles"), "static fixture should contain candidate lock cycles"

    runtime_id_for_expression = {
        "&runtime_lock_a": "A", "&runtime_lock_b": "B",
        "&static_only_lock_c": "C", "&static_only_lock_d": "D",
    }
    static_to_runtime = {}
    for operation in report["api_operations"]:
        lock = operation.get("lock") or {}
        runtime_id = runtime_id_for_expression.get(lock.get("expression"))
        identity = lock.get("identity_template")
        if runtime_id and identity:
            previous = static_to_runtime.setdefault(identity, runtime_id)
            assert previous == runtime_id
    assert {"A", "B", "C", "D"} <= set(static_to_runtime.values())
    comparison = evidence.compare(report, {"static_to_runtime": static_to_runtime}, [static_only])
    assert any(item["runtime_status"] == "not_observed_not_disproven"
               and any(lock in {"C", "D"} for lock in item.get("runtime_lock_sequence", []))
               for item in comparison["findings"]), comparison

    separate_runs = evidence.compare(report, {"static_to_runtime": static_to_runtime}, [safe, reverse_only])
    assert not any(item["runtime_status"] == "order_cycle_observed_without_deadlock"
                   for item in separate_runs["findings"]), separate_runs
    assert any(item["runtime_status"] == "partially_observed_not_disproven"
               and set(item.get("runtime_lock_sequence", [])) == {"A", "B"}
               for item in separate_runs["findings"]), separate_runs

    same_run_orders = evidence.compare(report, {"static_to_runtime": static_to_runtime}, [opposite])
    assert any(item["runtime_status"] == "order_cycle_observed_without_deadlock"
               and set(item.get("runtime_lock_sequence", [])) == {"A", "B"}
               for item in same_run_orders["findings"]), same_run_orders

    benchmark = evidence.benchmark(demo, iterations=100, repeats=3, timeout=20)
    assert benchmark["median_ns"]["baseline"] > 0
    assert benchmark["median_ns"]["instrumented"] > 0
    assert len(benchmark["samples_ns"]["baseline"]) == 3
    assert benchmark["overhead_percent"] is not None

print("runtime trace, contention, timeout, comparison and overhead checks passed")
