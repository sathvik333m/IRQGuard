#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


binary, fixture, invalid_fixture, custom_config, invalid_config = sys.argv[1:]
fixture = pathlib.Path(fixture)
invalid_fixture = pathlib.Path(invalid_fixture)
custom_config = pathlib.Path(custom_config)
invalid_config = pathlib.Path(invalid_config)

run = subprocess.run([binary, "analyze", "--source", str(fixture), "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
data = json.loads(run.stdout)
assert data["analysis_kind"] == "interrupt_aware_lock_analysis"
functions = {function["name"]: function for function in data["functions"]}
assert {"inner", "indirect", "analyze_me"}.issubset(functions)
assert all(item["location"]["expansion"]["line"] > 0 for item in functions.values())

edges = {(call["caller"].split("::")[-1], call["callee"].split("::")[-1])
         for call in data["calls"]}
assert ("analyze_me", "inner") in edges
assert ("analyze_me", "indirect") in edges

api_names = [item["api"] for item in data["api_operations"]]
for expected in ("mutex_lock", "mutex_unlock", "spin_lock", "spin_unlock",
                 "spin_lock_irqsave", "spin_unlock_irqrestore", "local_irq_disable",
                 "local_irq_enable", "request_irq", "free_irq"):
    assert expected in api_names, f"missing API operation: {expected}"

lock_ops = [item for item in data["api_operations"] if item["lock"] is not None]
assert any(item["lock"]["syntax"] == "array_subscript" for item in lock_ops)
assert all(item["lock"]["identity_status"] in {"symbolic", "unresolved"} for item in lock_ops)
assert all("identity_template" in item["lock"] for item in lock_ops)
assert any(item["location"]["is_macro"] for item in data["api_operations"]), "macro call location missing"
macro_api = next(item for item in data["api_operations"] if item["location"]["is_macro"])
assert macro_api["location"]["expansion"]["valid"]
assert macro_api["location"]["spelling"]["valid"]
assert {"if", "for"}.issubset({item["kind"] for item in data["control_constructs"]})
assert all(item["location"]["expansion"]["line"] > 0 for item in data["calls"])

bad = subprocess.run([binary, "analyze", "--source", str(invalid_fixture)],
                     text=True, capture_output=True)
assert bad.returncode != 0, "invalid C unexpectedly succeeded"
assert "Clang failed" in bad.stderr and ("error:" in bad.stderr or "expected" in bad.stderr)

missing = subprocess.run([binary, "analyze", "--source", str(fixture) + ".missing"],
                         text=True, capture_output=True)
assert missing.returncode != 0
assert "error:" in missing.stderr

bad_cli = subprocess.run([binary, "analyze", "--source", str(fixture), "--format", "yaml"],
                         text=True, capture_output=True)
assert bad_cli.returncode != 0 and "--format" in bad_cli.stderr

configured = subprocess.run([binary, "analyze", "--source", str(fixture), "--format", "json",
                             "--api-config", str(custom_config)], text=True, capture_output=True)
assert configured.returncode == 0, configured.stderr
custom_data = json.loads(configured.stdout)
assert any(item["api"] == "spin_lock" and item["kind"] == "custom_spin_acquire"
           for item in custom_data["api_operations"])
assert any(item["api"] == "project_lock" and item["lock"]["expression"] == "s"
           for item in custom_data["api_operations"])

bad_config = subprocess.run([binary, "analyze", "--source", str(fixture),
                             "--api-config", str(invalid_config)], text=True, capture_output=True)
assert bad_config.returncode != 0 and "API config" in bad_config.stderr
print("all analyzer extraction tests passed")
