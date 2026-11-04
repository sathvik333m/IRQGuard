#!/usr/bin/env python3
"""Regression checks for acquire/release counts and operation inventories."""
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


kernel_eval = load("run_kernel_eval", ROOT / "evaluation/run_kernel_eval.py")
inventory = load("lock_operation_inventory", ROOT / "evaluation/lock_operation_inventory.py")

operations = [
    {"api": "spin_lock", "kind": "lock_acquire"},
    {"api": "spin_unlock", "kind": "lock_release"},
    {"api": "spin_lock_irqsave", "kind": "lock_acquire_irqsave"},
    {"api": "spin_unlock_irqrestore", "kind": "lock_release_irqrestore"},
    {"api": "custom_lock_operation", "kind": "lock_custom_unknown"},
    {"api": "not_a_lock", "kind": "irq_disable"},
]
counts = kernel_eval.report_counts({"api_operations": operations})
assert counts["lock_operations"] == 5
assert counts["lock_acquisitions"] == 2
assert counts["lock_releases"] == 2
assert counts["other_lock_operations"] == 1
assert counts["lock_operations"] == counts["lock_acquisitions"] + counts["lock_releases"] + counts["other_lock_operations"]

records = inventory.report_operations({"api_operations": operations}, "fixture.c", "fixture-sha")
assert len(records) == 5
assert inventory.counts(records) == {
    "lock_operations": 5,
    "lock_acquisitions": 2,
    "lock_releases": 2,
    "by_classification": {
        "lock_acquire": 1,
        "lock_acquire_irqsave": 1,
        "lock_custom_unknown": 1,
        "lock_release": 1,
        "lock_release_irqrestore": 1,
    },
}

sample = {
    "translation_unit": "netdev.c", "function": "f", "api": "spin_lock",
    "classification": "lock_acquire", "source_location": {"file": "netdev.c", "line": 10, "column": 2},
    "lock_identity": "lock",
}
same = dict(sample)
assert inventory.compare_operations([sample], [same])["summary"] == {"same_and_consistently_classified": 1}
reclassified = dict(sample, classification="lock_release", api="spin_unlock")
assert inventory.compare_operations([sample], [reclassified])["summary"] == {"reclassified": 1}
assert inventory.compare_operations([sample], [])["summary"] == {"missing": 1}
assert inventory.compare_operations([], [sample])["summary"] == {"newly_detected": 1}
assert inventory.compare_operations([sample, sample], [sample])["summary"] == {"duplicated": 1}

print("Lock operation accounting and inventory checks passed.")
