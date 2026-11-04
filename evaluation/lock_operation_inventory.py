#!/usr/bin/env python3
"""Build detailed lock-operation inventories and compare report snapshots."""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
from pathlib import Path
import tarfile
from typing import Any


LOCK_KINDS = {"lock_acquire", "lock_acquire_irqsave", "lock_release", "lock_release_irqrestore"}


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def report_operations(report: dict[str, Any], report_name: str, digest: str) -> list[dict[str, Any]]:
    result = []
    for operation in report.get("api_operations", []):
        kind = str(operation.get("kind", ""))
        if not kind.startswith("lock_"):
            continue
        location = operation.get("location") or {}
        expansion = location.get("expansion") or {}
        spelling = location.get("spelling") or {}
        lock = operation.get("lock") or {}
        lock_location = lock.get("location") or {}
        result.append({
            "translation_unit": report_name,
            "function": operation.get("caller"),
            "api": operation.get("api"),
            "classification": kind,
            "source_location": expansion,
            "macro_spelling_location": spelling,
            "is_macro": bool(location.get("is_macro", False)),
            "lock_expression": lock.get("expression"),
            "lock_identity": lock.get("identity_template"),
            "lock_identity_status": lock.get("identity_status"),
            "lock_expression_location": lock_location,
            "saved_irq_flags_expression": operation.get("state_expression") or None,
            "saved_irq_flags_identity": operation.get("state_identity") or None,
            "saved_irq_flags_identity_status": operation.get("state_identity_status"),
            "report_sha256": digest,
        })
    return sorted(result, key=lambda item: (
        item.get("translation_unit") or "", item.get("source_location", {}).get("file", ""),
        item.get("source_location", {}).get("line", 0), item.get("source_location", {}).get("column", 0),
        item.get("function") or "", item.get("api") or "", item.get("classification") or ""))


def load_directory(directory: Path) -> tuple[list[dict[str, Any]], dict[str, str]]:
    operations: list[dict[str, Any]] = []
    reports: dict[str, str] = {}
    for path in sorted(directory.glob("*.json")):
        raw = path.read_bytes()
        report = json.loads(raw)
        reports[path.name] = file_hash(raw)
        operations.extend(report_operations(report, path.name, reports[path.name]))
    return operations, reports


def load_archive(archive_path: Path) -> tuple[list[dict[str, Any]], dict[str, str]]:
    operations: list[dict[str, Any]] = []
    reports: dict[str, str] = {}
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in sorted(archive.getmembers(), key=lambda item: item.name):
            if not member.isfile() or not member.name.endswith(".json"):
                continue
            stream = archive.extractfile(member)
            if stream is None:
                continue
            raw = stream.read()
            name = Path(member.name).name
            digest = file_hash(raw)
            reports[name] = digest
            operations.extend(report_operations(json.loads(raw), name, digest))
    return operations, reports


def counts(operations: list[dict[str, Any]]) -> dict[str, int]:
    by_kind = collections.Counter(item["classification"] for item in operations)
    return {
        "lock_operations": len(operations),
        "lock_acquisitions": sum(by_kind[kind] for kind in ("lock_acquire", "lock_acquire_irqsave")),
        "lock_releases": sum(by_kind[kind] for kind in ("lock_release", "lock_release_irqrestore")),
        "by_classification": dict(sorted(by_kind.items())),
    }


def site_key(item: dict[str, Any]) -> tuple[Any, ...]:
    location = item.get("source_location") or {}
    return (item.get("translation_unit"), item.get("function"), location.get("file"),
            location.get("line"), location.get("column"), item.get("lock_identity"))


def compare_operations(reference: list[dict[str, Any]], current: list[dict[str, Any]]) -> dict[str, Any]:
    ref_groups: dict[tuple[Any, ...], list[dict[str, Any]]] = collections.defaultdict(list)
    cur_groups: dict[tuple[Any, ...], list[dict[str, Any]]] = collections.defaultdict(list)
    for item in reference:
        ref_groups[site_key(item)].append(item)
    for item in current:
        cur_groups[site_key(item)].append(item)
    comparisons = []
    for key in sorted(set(ref_groups) | set(cur_groups), key=str):
        left = ref_groups.get(key, [])
        right = cur_groups.get(key, [])
        if len(left) > 1 or len(right) > 1:
            status = "duplicated"
        elif not left:
            status = "newly_detected"
        elif not right:
            status = "missing"
        elif (left[0].get("classification"), left[0].get("api")) != (
                right[0].get("classification"), right[0].get("api")):
            status = "reclassified"
        else:
            status = "same_and_consistently_classified"
        comparisons.append({
            "status": status,
            "site": {"translation_unit": key[0], "function": key[1], "file": key[2],
                     "line": key[3], "column": key[4], "lock_identity": key[5]},
            "reference_operations": left,
            "current_operations": right,
        })
    summary = collections.Counter(item["status"] for item in comparisons)
    return {"summary": dict(sorted(summary.items())), "operations": comparisons}


def build_snapshot(name: str, operations: list[dict[str, Any]], reports: dict[str, str]) -> dict[str, Any]:
    return {"name": name, "report_sha256_by_translation_unit": dict(sorted(reports.items())),
            "counts": counts(operations), "operations": operations}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase15-archive", type=Path, required=True)
    parser.add_argument("--phase17-reports", type=Path, required=True)
    parser.add_argument("--fresh-reports", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    phase15_ops, phase15_hashes = load_archive(args.phase15_archive)
    phase17_ops, phase17_hashes = load_directory(args.phase17_reports)
    fresh_ops, fresh_hashes = load_directory(args.fresh_reports)
    snapshots = [build_snapshot("phase15_archive", phase15_ops, phase15_hashes),
                 build_snapshot("phase17_saved_reports", phase17_ops, phase17_hashes),
                 build_snapshot("phase19.1_fresh", fresh_ops, fresh_hashes)]
    inventory = {"schema_version": 1, "kernel_revision": "814637ca257f4faf57a73fd4e38888cce88b5911",
                 "snapshots": snapshots}
    comparisons = {"schema_version": 1,
                   "comparisons": {
                       "phase15_to_phase17": compare_operations(phase15_ops, phase17_ops),
                       "phase17_to_fresh": compare_operations(phase17_ops, fresh_ops),
                       "phase15_to_fresh": compare_operations(phase15_ops, fresh_ops),
                   }}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "operation-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    (args.output / "operation-comparison.json").write_text(json.dumps(comparisons, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({snapshot["name"]: snapshot["counts"] for snapshot in snapshots}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
