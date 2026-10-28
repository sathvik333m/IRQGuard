#!/usr/bin/env python3
"""Summarize analyzer reports into the three documented evaluation views.

The views are projections over one schema-v3 or schema-v4 report, not separate
analyzer implementations or runs. Basic cycles are counted as cyclic strongly
connected components in the interprocedural lock-dependency graph. The other
two views use the analyzer's context graph and emitted feasibility categories.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from summarize_uncertainties import summarize as summarize_uncertainties


def cyclic_scc_count(edges: list[dict[str, Any]]) -> int:
    graph: dict[str, set[str]] = defaultdict(set)
    vertices: set[str] = set()
    for edge in edges:
        source = edge.get("from_lock")
        target = edge.get("to_lock")
        if isinstance(source, str) and isinstance(target, str):
            graph[source].add(target)
            vertices.update((source, target))

    # Raise CPython's conservative recursive DFS limit for larger lock graphs.
    sys.setrecursionlimit(max(sys.getrecursionlimit(), len(vertices) * 2 + 100))

    index = 0
    indices: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    stack: list[str] = []
    active: set[str] = set()
    cyclic = 0

    def visit(vertex: str) -> None:
        nonlocal index, cyclic
        indices[vertex] = lowlink[vertex] = index
        index += 1
        stack.append(vertex)
        active.add(vertex)
        for target in graph.get(vertex, set()):
            if target not in indices:
                visit(target)
                lowlink[vertex] = min(lowlink[vertex], lowlink[target])
            elif target in active:
                lowlink[vertex] = min(lowlink[vertex], indices[target])
        if lowlink[vertex] == indices[vertex]:
            component = []
            while True:
                member = stack.pop()
                active.remove(member)
                component.append(member)
                if member == vertex:
                    break
            if len(component) > 1 or vertex in graph.get(vertex, set()):
                cyclic += 1

    for vertex in sorted(vertices):
        if vertex not in indices:
            visit(vertex)
    return cyclic


def summarize(report: dict[str, Any]) -> dict[str, Any]:
    dependencies = report.get("lock_dependencies", [])
    lock_operations = [item for item in report.get("api_operations", [])
                       if str(item.get("kind", "")).startswith("lock_")]
    graph = report.get("interrupt_lock_graph", {})
    edges = graph.get("edges", []) if isinstance(graph, dict) else []
    categories: dict[str, int] = defaultdict(int)
    for finding in report.get("interrupt_cycles", []):
        categories[str(finding.get("category", "unknown"))] += 1
    uncertainty = report.get("uncertainty_summary")
    if not isinstance(uncertainty, dict):
        uncertainty = summarize_uncertainties(report)
    uncertainty_counts = {
        key: uncertainty.get(key)
        for key in ("event_count", "unique_record_count", "propagated_event_count",
                    "high_impact_unique_records", "lock_identity_events",
                    "interrupt_state_events", "unresolved_call_events",
                    "candidate_affecting_unique_records", "affected_candidate_count",
                    "candidate_record_association_count", "proven_non_affecting_event_count",
                    "by_category", "by_stage")
    }

    basic = cyclic_scc_count(dependencies)
    interrupt_candidates = categories.get("interrupt_aware_candidate", 0)
    normal_candidates = categories.get("candidate_lock_order_cycle", 0)
    interrupt_view = {
        "candidate_lock_order_cycles": normal_candidates,
        "interrupt_aware_candidates": interrupt_candidates,
        "candidate_findings_total": normal_candidates + interrupt_candidates,
    }
    refined = {
        "candidate_lock_order_cycle": normal_candidates,
        "interrupt_aware_candidate": interrupt_candidates,
        "rejected_candidate": categories.get("rejected_candidate", 0),
        "inconclusive_analysis": categories.get("inconclusive_analysis", 0),
        "finding_categories": dict(sorted(categories.items())),
    }
    return {
        "analysis_kind": report.get("analysis_kind"),
        "schema_version": report.get("schema_version"),
        "counts": {
            "functions": len(report.get("functions", [])),
            "lock_operations": len(lock_operations),
            "lock_dependencies": len(dependencies),
            "interrupt_graph_edges": len(edges),
            "interrupt_graph_nodes": len(graph.get("nodes", [])) if isinstance(graph, dict) else 0,
            "uncertainties": len(report.get("uncertainties", [])),
            "unique_uncertainty_records": uncertainty_counts["unique_record_count"],
            "diagnostics": len(report.get("diagnostics", [])),
        },
        "uncertainty_counts": uncertainty_counts,
        "basic_lock_cycle_view": {"cyclic_scc_count": basic},
        "interrupt_aware_view": interrupt_view,
        "feasibility_refined_view": refined,
        "limits": [
            "The three views are projections over one analyzer report, not separately configured analyzer executions.",
            "A cyclic SCC is not a count of distinct simple cycles and is not a deadlock confirmation.",
            "Static candidates require independent source review; no precision or recall is computed without labeled ground truth.",
        ],
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: summarize.py REPORT.json SUMMARY.json", file=sys.stderr)
        return 2
    source, destination = map(Path, sys.argv[1:])
    try:
        report = json.loads(source.read_text(encoding="utf-8"))
        result = summarize(report)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError, AttributeError, TypeError) as error:
        print(f"evaluation summary error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
