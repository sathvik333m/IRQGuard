#!/usr/bin/env python3
"""Exercise the unified CLI across static analysis and runtime evidence."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(sys.argv[1]).resolve()
CLI = ROOT / "irqguard"


def invoke(*arguments, expected=0):
    result = subprocess.run([str(CLI), *map(str, arguments)], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == expected, (
        f"command {arguments!r} returned {result.returncode}, expected {expected}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    return result


with tempfile.TemporaryDirectory(prefix="irqguard-cli-test-") as temporary:
    temp = Path(temporary)
    help_result = invoke("--help")
    assert "analyze" in help_result.stdout and "benchmark" in help_result.stdout

    basic = invoke("analyze", "--source", ROOT / "examples/basic.c", "--format", "json")
    report = json.loads(basic.stdout)
    assert report["schema_version"] == 4
    assert {item["name"] for item in report["functions"]} >= {"worker", "update_state"}
    assert report["lock_dependencies"], "ordinary source example should show an interprocedural dependency"

    dot_path = temp / "locks.dot"
    invoke("graph", "--source", ROOT / "runtime/fixtures/lock_orders.c",
           "--api-config", ROOT / "runtime/apis.json", "--clang-arg", "-Iruntime", "--output", dot_path)
    dot = dot_path.read_text(encoding="utf-8")
    assert "digraph interrupt_lock_dependencies" in dot and "runtime_lock_a" in dot

    invoke("api-registry", "validate", "--config", ROOT / "config/apis.example.json")
    invalid_registry = temp / "bad-apis.json"
    invalid_registry.write_text('{"apis":[{"name":"broken","kind":"acquire","lock_argument":-1}]}', encoding="utf-8")
    rejected = invoke("api-registry", "validate", "--config", invalid_registry, expected=2)
    assert "lock_argument" in rejected.stderr

    static_path = temp / "static.json"
    static_result = invoke("analyze", "--source", ROOT / "runtime/fixtures/lock_orders.c",
                          "--api-config", ROOT / "runtime/apis.json", "--clang-arg", "-Iruntime",
                          "--format", "json", "--output", static_path)
    static = json.loads(static_path.read_text(encoding="utf-8"))
    assert static_result.stdout == ""
    assert static["interrupt_cycles"], "runtime lock-order fixture should contain static candidates"

    runtime_trace = temp / "static-only.jsonl"
    runtime_summary = temp / "static-only.summary.json"
    invoke("runtime", "run", "--scenario", "static-only", "--trace", runtime_trace,
           "--summary", runtime_summary)
    assert json.loads(runtime_summary.read_text(encoding="utf-8"))["scenario"] == "static-only"

    mapping_by_expression = {
        "&runtime_lock_a": "A", "&runtime_lock_b": "B",
        "&static_only_lock_c": "C", "&static_only_lock_d": "D",
    }
    mapping = {}
    for operation in static["api_operations"]:
        lock = operation.get("lock") or {}
        runtime_id = mapping_by_expression.get(lock.get("expression"))
        if runtime_id and lock.get("identity_template"):
            mapping[lock["identity_template"]] = runtime_id
    mapping_path = temp / "lock-map.json"
    mapping_path.write_text(json.dumps({"static_to_runtime": mapping}), encoding="utf-8")
    comparison_path = temp / "comparison.json"
    invoke("compare", "--static-report", static_path, "--lock-map", mapping_path,
           "--trace", runtime_trace, "--termination", "completed", "--output", comparison_path)
    comparison = json.loads(comparison_path.read_text(encoding="utf-8"))
    assert comparison["runtime_scope"] == "controlled_userspace_only; no hardware interrupt emulation"
    assert any(item["runtime_status"] == "not_observed_not_disproven" for item in comparison["findings"])

print("unified CLI static analysis, registry, Graphviz and static/runtime integration passed")
