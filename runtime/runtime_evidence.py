#!/usr/bin/env python3
"""Collect, summarize and compare controlled userspace lock traces."""

from __future__ import annotations

import argparse
import json
import os
import platform
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


SCENARIOS = {"safe", "reverse-only", "opposite-order", "contention", "deadlock", "static-only"}


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read JSON from {path}: {error}") from error


def read_trace(path: Path) -> list[dict[str, Any]]:
    events = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ValueError(f"cannot read trace {path}: {error}") from error
    for line_number, line in enumerate(lines, 1):
        try:
            item = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSONL at {path}:{line_number}: {error}") from error
        required = ("schema_version", "run_id", "sequence", "timestamp_monotonic_ns",
                    "process_id", "thread_id", "lock_id", "event")
        if not isinstance(item, dict) or any(key not in item for key in required):
            raise ValueError(f"trace event at {path}:{line_number} is missing required fields")
        if item["schema_version"] != 1 or item["event"] not in {
            "acquire_attempt", "contention_observed", "acquire_success", "release"
        }:
            raise ValueError(f"unsupported trace event at {path}:{line_number}")
        events.append(item)
    if not events:
        raise ValueError(f"trace has no events: {path}")
    run_ids = {event["run_id"] for event in events}
    if len(run_ids) != 1:
        raise ValueError(f"trace contains multiple runs; keep one process invocation per trace file: {path}")
    return sorted(events, key=lambda event: event["sequence"])


def directed_cycles(adjacency: dict[str, set[str]]) -> list[list[str]]:
    """Return canonical thread cycles, without combining distinct trace runs."""
    found: set[tuple[str, ...]] = set()
    for start in sorted(adjacency):
        path = [start]
        active = {start}

        def visit(node: str) -> None:
            for target in sorted(adjacency.get(node, set())):
                if target == start:
                    cycle = path[:]
                    rotations = [tuple(cycle[index:] + cycle[:index]) for index in range(len(cycle))]
                    found.add(min(rotations))
                elif target not in active and len(path) < len(adjacency):
                    active.add(target)
                    path.append(target)
                    visit(target)
                    path.pop()
                    active.remove(target)

        visit(start)
    return [list(cycle) + [cycle[0]] for cycle in sorted(found)]


def summarize_trace(events: list[dict[str, Any]], termination: str = "unknown") -> dict[str, Any]:
    held_by_thread: dict[str, list[str]] = defaultdict(list)
    owners: dict[str, str] = {}
    waiting: dict[str, str] = {}
    order_provenance: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    observed_wait_cycles: list[dict[str, Any]] = []
    event_counts: Counter[str] = Counter()
    contention_events = []

    for event in events:
        kind = event["event"]
        thread = str(event["thread_id"])
        lock = str(event["lock_id"])
        event_counts[kind] += 1
        if kind == "contention_observed":
            contention_events.append(event)
            waiting[thread] = lock
            adjacency: dict[str, set[str]] = defaultdict(set)
            wait_edges = []
            for waiter, wanted_lock in waiting.items():
                owner = owners.get(wanted_lock)
                if owner is not None and owner != waiter:
                    adjacency[waiter].add(owner)
                    wait_edges.append({
                        "waiter_thread": waiter,
                        "waiting_for_lock": wanted_lock,
                        "owner_thread": owner,
                        "locks_held_by_waiter": list(held_by_thread.get(waiter, [])),
                    })
            for cycle in directed_cycles(adjacency):
                cycle_threads = set(cycle[:-1])
                cycle_edges = [edge for edge in wait_edges if edge["waiter_thread"] in cycle_threads]
                key = (tuple(cycle), tuple(sorted((edge["waiter_thread"], edge["waiting_for_lock"], edge["owner_thread"]) for edge in cycle_edges)))
                if not any(item["_key"] == key for item in observed_wait_cycles):
                    observed_wait_cycles.append({"_key": key, "threads": cycle, "edges": cycle_edges,
                                                 "first_observed_sequence": event["sequence"]})
        elif kind == "acquire_success":
            waiting.pop(thread, None)
            for held_lock in held_by_thread[thread]:
                if held_lock != lock:
                    order_provenance[(held_lock, lock)].append({
                        "thread_id": thread,
                        "sequence": event["sequence"],
                        "timestamp_monotonic_ns": event["timestamp_monotonic_ns"],
                    })
            held_by_thread[thread].append(lock)
            owners[lock] = thread
        elif kind == "release":
            waiting.pop(thread, None)
            try:
                held_by_thread[thread].remove(lock)
            except ValueError:
                pass
            if owners.get(lock) == thread:
                owners.pop(lock, None)

    adjacency = defaultdict(set)
    terminal_edges = []
    for waiter, wanted_lock in waiting.items():
        owner = owners.get(wanted_lock)
        if owner is not None and owner != waiter:
            adjacency[waiter].add(owner)
            terminal_edges.append({
                "waiter_thread": waiter,
                "waiting_for_lock": wanted_lock,
                "owner_thread": owner,
                "locks_held_by_waiter": list(held_by_thread.get(waiter, [])),
            })
    terminal_cycles = []
    for cycle in directed_cycles(adjacency):
        cycle_threads = set(cycle[:-1])
        terminal_cycles.append({
            "threads": cycle,
            "edges": [edge for edge in terminal_edges if edge["waiter_thread"] in cycle_threads],
            "locks_involved": sorted({
                lock for edge in terminal_edges if edge["waiter_thread"] in cycle_threads
                for lock in [edge["waiting_for_lock"], *edge["locks_held_by_waiter"]]
            }),
        })

    cleaned_wait_cycles = [{key: value for key, value in item.items() if key != "_key"}
                           for item in observed_wait_cycles]
    result = {
        "trace_schema_version": 1,
        "run_id": events[0]["run_id"],
        "process_id": events[0]["process_id"],
        "termination": termination,
        "event_count": len(events),
        "thread_count": len({str(event["thread_id"]) for event in events}),
        "event_counts": dict(sorted(event_counts.items())),
        "observed_contention_count": len(contention_events),
        "observed_lock_orders": [
            {"from_lock": source, "to_lock": target, "observation_count": len(origins),
             "provenance": origins}
            for (source, target), origins in sorted(order_provenance.items())
        ],
        "observed_wait_for_cycles": cleaned_wait_cycles,
        "terminal_wait_for_cycles": terminal_cycles,
        "deadlock_reproduction": (
            "watchdog_timeout_with_persistent_wait_for_cycle"
            if termination == "watchdog_timeout" and terminal_cycles else "not_confirmed"
        ),
        "interpretation": (
            "A wait-for cycle remained in this controlled process until the watchdog terminated it. "
            "This reproduces the fixture's deadlock within the timeout; it does not prove a deadlock "
            "in arbitrary software."
            if termination == "watchdog_timeout" and terminal_cycles else
            "Observed lock orders describe this run only. Their presence or absence does not prove "
            "deadlock freedom."
        ),
    }
    return result


def run_scenario(program: Path, scenario: str, trace: Path, timeout: float) -> dict[str, Any]:
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario {scenario!r}")
    trace.parent.mkdir(parents=True, exist_ok=True)
    trace.unlink(missing_ok=True)
    run_id = uuid.uuid4().hex
    environment = os.environ.copy()
    environment["IRQGUARD_TRACE"] = str(trace.resolve())
    environment["IRQGUARD_RUN_ID"] = run_id
    process = subprocess.Popen([str(program), scenario], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=environment, start_new_session=True)
    termination = "completed"
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return_code = process.returncode
        if return_code != 0:
            termination = "exited_nonzero"
    except subprocess.TimeoutExpired:
        termination = "watchdog_timeout"
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = process.communicate()
        return_code = process.returncode
    events = read_trace(trace)
    summary = summarize_trace(events, termination)
    summary.update({"scenario": scenario, "return_code": return_code,
                    "stdout": stdout[-2000:], "stderr": stderr[-4000:]})
    return summary


def compare(static_report: dict[str, Any], lock_map: dict[str, Any], summaries: list[dict[str, Any]]) -> dict[str, Any]:
    static_to_runtime = lock_map.get("static_to_runtime")
    if not isinstance(static_to_runtime, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in static_to_runtime.items()
    ):
        raise ValueError("lock map must contain a static_to_runtime object mapping exact static lock identities to runtime IDs")

    findings = []
    for index, candidate in enumerate(static_report.get("interrupt_cycles", []), 1):
        if not isinstance(candidate, dict):
            continue
        category = candidate.get("category", "inconclusive_analysis")
        sequence = candidate.get("lock_sequence", [])
        locks = sequence[:-1] if len(sequence) > 1 and sequence[0] == sequence[-1] else sequence
        if category == "interrupt_aware_candidate":
            findings.append({"finding_id": f"static-{index:03d}", "category": category,
                             "runtime_status": "not_comparable_userspace_interrupt_context",
                             "explanation": "Userspace traces do not reproduce hard-interrupt preemption."})
            continue
        unmapped = sorted({lock for lock in locks if lock not in static_to_runtime})
        if unmapped:
            findings.append({"finding_id": f"static-{index:03d}", "category": category,
                             "runtime_status": "identity_mapping_incomplete", "unmapped_static_locks": unmapped,
                             "explanation": "Exact static lock identities need an explicit runtime mapping."})
            continue
        runtime_sequence = [static_to_runtime[lock] for lock in locks]
        required_edges = list(zip(runtime_sequence, runtime_sequence[1:] + runtime_sequence[:1]))
        per_run = []
        for summary in summaries:
            observed = {(item["from_lock"], item["to_lock"])
                        for item in summary.get("observed_lock_orders", [])}
            matched = [edge for edge in required_edges if edge in observed]
            cycles = summary.get("terminal_wait_for_cycles", [])
            deadlock_match = any(set(runtime_sequence).issubset(set(cycle.get("locks_involved", [])))
                                 for cycle in cycles)
            per_run.append({"run_id": summary.get("run_id"), "scenario": summary.get("scenario"),
                            "matched_order_edges": [list(edge) for edge in matched],
                            "required_order_edges": [list(edge) for edge in required_edges],
                            "wait_for_cycle_overlaps": deadlock_match,
                            "deadlock_reproduction": summary.get("deadlock_reproduction")})
        best = max((len(item["matched_order_edges"]) for item in per_run), default=0)
        if any(item["wait_for_cycle_overlaps"] and item["deadlock_reproduction"] ==
               "watchdog_timeout_with_persistent_wait_for_cycle" for item in per_run):
            status = "watchdog_deadlock_reproduced_in_controlled_process"
            explanation = "The mapped lock cycle overlapped a wait-for cycle that persisted until watchdog termination."
        elif required_edges and best == len(required_edges):
            status = "order_cycle_observed_without_deadlock"
            explanation = "All lock-order directions appeared in one run, but no persistent wait-for cycle was observed."
        elif best:
            status = "partially_observed_not_disproven"
            explanation = "Some candidate lock orders appeared; unobserved paths remain untested, not disproven."
        else:
            status = "not_observed_not_disproven"
            explanation = "This runtime set did not observe the candidate's lock orders; that does not disprove it."
        findings.append({"finding_id": f"static-{index:03d}", "category": category,
                         "runtime_status": status, "static_lock_sequence": sequence,
                         "runtime_lock_sequence": runtime_sequence, "runs": per_run,
                         "explanation": explanation})
    return {
        "comparison_schema_version": 1,
        "static_report_schema_version": static_report.get("schema_version"),
        "runtime_scope": "controlled_userspace_only; no hardware interrupt emulation",
        "run_count": len(summaries),
        "findings": findings,
        "interpretation": "Runtime traces are execution observations, not a proof of safety. A missing observation is not a disproved static candidate.",
    }


def benchmark(program: Path, iterations: int, repeats: int, timeout: float) -> dict[str, Any]:
    samples: dict[str, list[int]] = {"baseline": [], "instrumented": []}
    with tempfile.TemporaryDirectory(prefix="irqguard-runtime-bench-") as temporary:
        directory = Path(temporary)
        for index in range(repeats):
            # Alternate order to reduce simple warm-up/order bias.
            order = ["baseline", "instrumented"] if index % 2 == 0 else ["instrumented", "baseline"]
            for mode in order:
                trace = directory / f"trace-{index}-{mode}.jsonl"
                command = [str(program), f"benchmark-{mode}", str(iterations)]
                environment = os.environ.copy()
                environment["IRQGUARD_TRACE"] = str(trace)
                environment["IRQGUARD_RUN_ID"] = uuid.uuid4().hex
                completed = subprocess.run(command, check=True, capture_output=True, text=True,
                                           env=environment, timeout=timeout)
                result = json.loads(completed.stdout)
                samples[mode].append(int(result["elapsed_ns"]))
    medians = {mode: int(statistics.median(values)) for mode, values in samples.items()}
    baseline = medians["baseline"]
    overhead_percent = ((medians["instrumented"] / baseline) - 1) * 100 if baseline else None
    return {
        "benchmark_schema_version": 1,
        "environment": {
            "operating_system": platform.platform(),
            "kernel_release": platform.release(),
            "architecture": platform.machine(),
            "logical_cpu_count": os.cpu_count(),
            "python_version": platform.python_version(),
        },
        "metric": "in-process elapsed nanoseconds for the same mutex-pair loop",
        "iterations_per_sample": iterations,
        "repeats": repeats,
        "samples_ns": samples,
        "median_ns": medians,
        "overhead_percent": overhead_percent,
        "formula": "(instrumented_median / baseline_median - 1) * 100",
        "limitations": "This measures wrapper, event serialization, synchronization and flush cost on this machine. It is not a portable or statistically generalized overhead result.",
    }


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run", help="run one bounded controlled scenario and save its summary")
    run_parser.add_argument("--program", type=Path, required=True)
    run_parser.add_argument("--scenario", choices=sorted(SCENARIOS), required=True)
    run_parser.add_argument("--trace", type=Path, required=True)
    run_parser.add_argument("--summary", type=Path)
    run_parser.add_argument("--timeout", type=float, default=3.0)
    analyze_parser = commands.add_parser("analyze", help="summarize one JSONL trace")
    analyze_parser.add_argument("--trace", type=Path, required=True)
    analyze_parser.add_argument("--termination", choices=["unknown", "completed", "watchdog_timeout"], default="unknown")
    analyze_parser.add_argument("--output", type=Path)
    compare_parser = commands.add_parser("compare", help="compare static candidates with separate runtime summaries")
    compare_parser.add_argument("--static-report", type=Path, required=True)
    compare_parser.add_argument("--lock-map", type=Path, required=True)
    compare_parser.add_argument("--summary", type=Path, action="append", required=True)
    compare_parser.add_argument("--output", type=Path)
    bench_parser = commands.add_parser("benchmark", help="measure instrumented and baseline lock-pair loops")
    bench_parser.add_argument("--program", type=Path, required=True)
    bench_parser.add_argument("--iterations", type=int, default=1000)
    bench_parser.add_argument("--repeats", type=int, default=5)
    bench_parser.add_argument("--timeout", type=float, default=30.0)
    bench_parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    try:
        if args.command == "run":
            summary = run_scenario(args.program.resolve(), args.scenario, args.trace, args.timeout)
            output = args.summary or Path(str(args.trace) + ".summary.json")
            write_json(output, summary)
            print(json.dumps({"summary": str(output), "scenario": args.scenario,
                              "termination": summary["termination"],
                              "deadlock_reproduction": summary["deadlock_reproduction"]}, indent=2))
        elif args.command == "analyze":
            result = summarize_trace(read_trace(args.trace), args.termination)
            if args.output:
                write_json(args.output, result)
            print(json.dumps(result, indent=2))
        elif args.command == "compare":
            result = compare(read_json(args.static_report), read_json(args.lock_map),
                             [read_json(path) for path in args.summary])
            if args.output:
                write_json(args.output, result)
            print(json.dumps(result, indent=2))
        else:
            if args.iterations < 1 or args.repeats < 1:
                raise ValueError("iterations and repeats must be positive")
            result = benchmark(args.program.resolve(), args.iterations, args.repeats, args.timeout)
            if args.output:
                write_json(args.output, result)
            print(json.dumps(result, indent=2))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
