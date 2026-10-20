from __future__ import annotations

import json
import os
import selectors
import signal
import sqlite3
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


REPO_ROOT = Path(__file__).resolve().parents[2]
ANALYZER_PATH = Path(os.environ.get("IRQGUARD_ANALYZER", REPO_ROOT / "build/deadlock-analyzer")).expanduser()
DATA_DIR = Path(os.environ.get("IRQGUARD_DATA_DIR", Path.home() / ".local/share/irqguard")).expanduser()
REPORT_DIR = DATA_DIR / "reports"
DATABASE = DATA_DIR / "history.sqlite3"
RUN_TIMEOUT_SECONDS = max(5, int(os.environ.get("IRQGUARD_TIMEOUT_SECONDS", "180")))
MAX_STREAM_BYTES = 16 * 1024 * 1024
MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_CONTEXT_LINES = 80
API_VERSION = "1"
ANALYZER_SCHEMA_VERSION = 3


def configured_roots() -> list[Path]:
    raw = os.environ.get("IRQGUARD_WORKSPACES", "")
    candidates = [Path(item).expanduser() for item in raw.split(os.pathsep) if item.strip()]
    if not candidates:
        candidates = [REPO_ROOT]
    roots: list[Path] = []
    for item in candidates:
        try:
            resolved = item.resolve(strict=True)
        except OSError:
            continue
        if resolved.is_dir() and resolved not in roots:
            roots.append(resolved)
    return roots


WORKSPACE_ROOTS = configured_roots()
RUN_SLOTS = threading.BoundedSemaphore(value=2)


class AnalysisRequest(BaseModel):
    source_path: str = Field(min_length=1, max_length=4096)
    compile_commands_path: Optional[str] = Field(default=None, max_length=4096)
    api_config_path: Optional[str] = Field(default=None, max_length=4096)

    class Config:
        extra = "forbid"


app = FastAPI(
    title="IRQGuard local analysis API",
    version=API_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATABASE, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS analyses (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            source_path TEXT NOT NULL,
            compile_commands_path TEXT,
            api_config_path TEXT,
            config_json TEXT NOT NULL,
            return_code INTEGER,
            duration_ms INTEGER,
            report_path TEXT,
            report_json TEXT,
            error TEXT
        )"""
    )
    conn.commit()
    return conn


@contextmanager
def db_connection():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def inside_workspace(path: Path) -> bool:
    for root in WORKSPACE_ROOTS:
        try:
            if os.path.commonpath((str(root), str(path))) == str(root):
                return True
        except ValueError:
            continue
    return False


def validated_path(value: str, *, label: str, must_exist: bool = True) -> Path:
    supplied = Path(value).expanduser()
    if not supplied.is_absolute():
        raise HTTPException(status_code=400, detail=f"{label} must be an absolute WSL/Linux path")
    try:
        path = supplied.resolve(strict=must_exist)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=400, detail=f"{label} does not exist or cannot be resolved")
    if not inside_workspace(path):
        raise HTTPException(status_code=403, detail=f"{label} is outside the configured workspace roots")
    return path


def validate_request_paths(payload: AnalysisRequest) -> tuple[Path, Optional[Path], Optional[Path]]:
    source = validated_path(payload.source_path, label="source_path")
    if not source.is_file() or source.suffix.lower() not in {".c", ".h"}:
        raise HTTPException(status_code=400, detail="source_path must identify a C source or header file")
    if source.stat().st_size > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="source file exceeds the 20 MiB analysis limit")

    compilation: Optional[Path] = None
    if payload.compile_commands_path:
        supplied = validated_path(payload.compile_commands_path, label="compile_commands_path")
        if supplied.is_dir():
            compilation = supplied
        elif supplied.is_file() and supplied.name == "compile_commands.json":
            compilation = supplied.parent
        else:
            raise HTTPException(
                status_code=400,
                detail="compile_commands_path must be a build directory or compile_commands.json",
            )
        if not (compilation / "compile_commands.json").is_file():
            raise HTTPException(status_code=400, detail="compilation database has no compile_commands.json")

    api_config: Optional[Path] = None
    if payload.api_config_path:
        api_config = validated_path(payload.api_config_path, label="api_config_path")
        if not api_config.is_file() or api_config.suffix.lower() != ".json":
            raise HTTPException(status_code=400, detail="api_config_path must identify a JSON file")
    return source, compilation, api_config


def source_paths_in_report(report: dict[str, Any]) -> set[Path]:
    paths: set[Path] = set()
    if isinstance(report.get("source"), str):
        try:
            paths.add(Path(report["source"]).expanduser().resolve(strict=True))
        except (OSError, RuntimeError):
            pass

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if value.get("valid") is True and isinstance(value.get("file"), str) and value["file"]:
                try:
                    paths.add(Path(value["file"]).expanduser().resolve(strict=True))
                except (OSError, RuntimeError):
                    pass
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(report)
    return {path for path in paths if inside_workspace(path)}


def summarize(report: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if report is None:
        return None
    functions = report.get("functions") if isinstance(report.get("functions"), list) else []
    operations = report.get("api_operations") if isinstance(report.get("api_operations"), list) else []
    dependencies = report.get("lock_dependencies") if isinstance(report.get("lock_dependencies"), list) else []
    graph = report.get("interrupt_lock_graph")
    graph_edges = graph.get("edges", []) if isinstance(graph, dict) else []
    cycles = report.get("interrupt_cycles") if isinstance(report.get("interrupt_cycles"), list) else []
    categories: dict[str, int] = {}
    for cycle in cycles:
        category = cycle.get("category", "inconclusive_analysis") if isinstance(cycle, dict) else "inconclusive_analysis"
        categories[category] = categories.get(category, 0) + 1
    return {
        "translation_units": 1,
        "functions": len(functions),
        "lock_operations": sum(1 for item in operations if isinstance(item, dict) and item.get("lock")),
        "lock_dependencies": len(dependencies),
        "graph_edges": len(graph_edges) if isinstance(graph_edges, list) else 0,
        "candidate_cycles": categories.get("candidate_lock_order_cycle", 0) + categories.get("interrupt_aware_candidate", 0),
        "rejected_candidates": categories.get("rejected_candidate", 0),
        "inconclusive_findings": categories.get("inconclusive_analysis", 0),
        "finding_categories": categories,
        "diagnostics": len(report.get("diagnostics", [])) if isinstance(report.get("diagnostics"), list) else None,
        "uncertainties": len(report.get("uncertainties", [])) if isinstance(report.get("uncertainties"), list) else None,
    }


def read_run(run_id: str) -> sqlite3.Row:
    with db_connection() as conn:
        row = conn.execute("SELECT * FROM analyses WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Analysis was not found")
    return row


def row_report(row: sqlite3.Row) -> Optional[dict[str, Any]]:
    if not row["report_json"]:
        return None
    try:
        report = json.loads(row["report_json"])
    except (TypeError, json.JSONDecodeError):
        raise HTTPException(status_code=500, detail="Stored analysis report is malformed")
    return report if isinstance(report, dict) else None


def to_metadata(row: sqlite3.Row) -> dict[str, Any]:
    report = row_report(row)
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "status": row["status"],
        "source_path": row["source_path"],
        "configuration": json.loads(row["config_json"]),
        "analyzer_schema_version": report.get("schema_version") if report else None,
        "analysis_kind": report.get("analysis_kind") if report else None,
        "duration_ms": row["duration_ms"],
        "return_code": row["return_code"],
        "summary": summarize(report),
        "error": row["error"],
    }


def read_process(command: list[str], cwd: Path) -> tuple[int, str, str, Optional[str]]:
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            start_new_session=True,
            bufsize=0,
        )
    except OSError as exc:
        return 127, "", "", f"Could not start the analyzer: {exc}"

    assert process.stdout is not None and process.stderr is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    chunks = {"stdout": bytearray(), "stderr": bytearray()}
    deadline = time.monotonic() + RUN_TIMEOUT_SECONDS
    failure: Optional[str] = None
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                failure = f"Analyzer exceeded the {RUN_TIMEOUT_SECONDS} second timeout"
                os.killpg(process.pid, signal.SIGKILL)
                break
            for key, _ in selector.select(timeout=0.2):
                block = os.read(key.fileobj.fileno(), 64 * 1024)
                if not block:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                bucket = chunks[key.data]
                if len(bucket) + len(block) > MAX_STREAM_BYTES:
                    failure = f"Analyzer {key.data} exceeded the {MAX_STREAM_BYTES // (1024 * 1024)} MiB output limit"
                    os.killpg(process.pid, signal.SIGKILL)
                    break
                bucket.extend(block)
            if failure:
                break
    finally:
        selector.close()
    if process.poll() is None:
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    for stream in (process.stdout, process.stderr):
        if stream and not stream.closed:
            stream.close()
    return process.returncode if process.returncode is not None else 1, chunks["stdout"].decode("utf-8", "replace"), chunks["stderr"].decode("utf-8", "replace"), failure


def update_run(run_id: str, *, status: str, return_code: Optional[int] = None,
               duration_ms: Optional[int] = None, report_path: Optional[str] = None,
               report_json: Optional[str] = None, error: Optional[str] = None) -> None:
    with db_connection() as conn:
        conn.execute(
            """UPDATE analyses SET status = ?, return_code = ?, duration_ms = ?,
               report_path = ?, report_json = ?, error = ? WHERE id = ?""",
            (status, return_code, duration_ms, report_path, report_json, error, run_id),
        )


def run_analysis(run_id: str, source: Path, compilation: Optional[Path], api_config: Optional[Path]) -> None:
    started = time.monotonic()
    update_run(run_id, status="running")
    command = [str(ANALYZER_PATH), "analyze", "--source", str(source), "--format", "json"]
    if compilation:
        command.extend(["--compile-commands", str(compilation)])
    if api_config:
        command.extend(["--api-config", str(api_config)])
    return_code, stdout, stderr, process_error = read_process(command, source.parent)
    duration_ms = int((time.monotonic() - started) * 1000)
    if process_error:
        update_run(run_id, status="failed", return_code=return_code, duration_ms=duration_ms,
                   error=process_error + (f"\n{stderr[-4000:]}" if stderr else ""))
        return
    if return_code != 0:
        explanation = stderr.strip() or f"Analyzer exited with status {return_code}"
        update_run(run_id, status="failed", return_code=return_code, duration_ms=duration_ms,
                   error=explanation[-8000:])
        return
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as exc:
        update_run(run_id, status="failed", return_code=return_code, duration_ms=duration_ms,
                   error=f"Analyzer output was not valid JSON: {exc}")
        return
    if not isinstance(report, dict) or report.get("schema_version") != ANALYZER_SCHEMA_VERSION or report.get("analysis_kind") != "interrupt_aware_lock_analysis":
        version = report.get("schema_version") if isinstance(report, dict) else None
        update_run(run_id, status="failed", return_code=return_code, duration_ms=duration_ms,
                   error=f"Unsupported analyzer report schema {version!r}; expected schema {ANALYZER_SCHEMA_VERSION}")
        return
    report_text = json.dumps(report, ensure_ascii=False, separators=(",", ":"))
    report_file = REPORT_DIR / f"{run_id}.json"
    temporary = report_file.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(report_file)
    update_run(run_id, status="completed", return_code=return_code, duration_ms=duration_ms,
               report_path=str(report_file), report_json=report_text)


@app.get("/api/v1/health")
def health() -> dict[str, Any]:
    return {
        "api_version": API_VERSION,
        "status": "ok",
        "analyzer_path": str(ANALYZER_PATH),
        "analyzer_available": ANALYZER_PATH.is_file() and os.access(ANALYZER_PATH, os.X_OK),
        "analyzer_report_schema": ANALYZER_SCHEMA_VERSION,
        "workspace_roots": [str(root) for root in WORKSPACE_ROOTS],
        "data_directory": str(DATA_DIR),
        "runtime_evidence_available": False,
        "benchmarks_available": False,
    }


@app.get("/api/v1/analyses")
def list_analyses(limit: int = Query(default=50, ge=1, le=100)) -> dict[str, Any]:
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM analyses ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return {"api_version": API_VERSION, "analyses": [to_metadata(row) for row in rows]}


@app.post("/api/v1/analyses", status_code=202)
def create_analysis(payload: AnalysisRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    if not ANALYZER_PATH.is_file() or not os.access(ANALYZER_PATH, os.X_OK):
        raise HTTPException(status_code=503, detail="Analyzer executable is unavailable; build it with CMake first")
    if not RUN_SLOTS.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Two analyses are already running; retry when one finishes")
    try:
        source, compilation, api_config = validate_request_paths(payload)
        run_id = uuid.uuid4().hex
        created_at = datetime.now(timezone.utc).isoformat()
        config = {
            "source_path": str(source),
            "compile_commands_path": str(compilation) if compilation else None,
            "api_config_path": str(api_config) if api_config else None,
            "format": "json",
        }
        with db_connection() as conn:
            conn.execute(
                """INSERT INTO analyses (id, created_at, status, source_path,
                   compile_commands_path, api_config_path, config_json)
                   VALUES (?, ?, 'queued', ?, ?, ?, ?)""",
                (run_id, created_at, str(source), config["compile_commands_path"],
                 config["api_config_path"], json.dumps(config)),
            )
        background_tasks.add_task(_run_and_release, run_id, source, compilation, api_config)
        return {"api_version": API_VERSION, "id": run_id, "status": "queued", "created_at": created_at}
    except Exception:
        RUN_SLOTS.release()
        raise


def _run_and_release(run_id: str, source: Path, compilation: Optional[Path], api_config: Optional[Path]) -> None:
    try:
        run_analysis(run_id, source, compilation, api_config)
    except Exception as exc:  # keep a broken task visible in history
        update_run(run_id, status="failed", error=f"Backend analysis task failed: {exc}")
    finally:
        RUN_SLOTS.release()


@app.get("/api/v1/analyses/{run_id}")
def get_analysis(run_id: str) -> dict[str, Any]:
    return {"api_version": API_VERSION, "analysis": to_metadata(read_run(run_id))}


@app.get("/api/v1/analyses/{run_id}/report")
def get_report(run_id: str) -> dict[str, Any]:
    report = row_report(read_run(run_id))
    if report is None:
        raise HTTPException(status_code=409, detail="Analysis has no completed report yet")
    return report


@app.get("/api/v1/analyses/{run_id}/findings")
def get_findings(run_id: str) -> dict[str, Any]:
    report = row_report(read_run(run_id))
    if report is None:
        raise HTTPException(status_code=409, detail="Analysis has no completed report yet")
    cycles = report.get("interrupt_cycles", [])
    return {
        "api_version": API_VERSION,
        "analysis_id": run_id,
        "schema_version": report.get("schema_version"),
        "findings": [dict(item, finding_id=f"{run_id[:8]}-{index + 1:03d}")
                     for index, item in enumerate(cycles) if isinstance(item, dict)],
    }


@app.get("/api/v1/analyses/{run_id}/graph")
def get_graph(run_id: str) -> dict[str, Any]:
    report = row_report(read_run(run_id))
    if report is None:
        raise HTTPException(status_code=409, detail="Analysis has no completed report yet")
    graph = report.get("interrupt_lock_graph")
    if not isinstance(graph, dict):
        raise HTTPException(status_code=422, detail="Analyzer report has no lock graph")
    return {"api_version": API_VERSION, "analysis_id": run_id, "schema_version": report.get("schema_version"),
            "nodes": graph.get("nodes", []), "edges": graph.get("edges", [])}


@app.get("/api/v1/analyses/{run_id}/source")
def get_source(run_id: str, file: str = Query(min_length=1, max_length=4096),
               line: int = Query(ge=1), context: int = Query(default=8, ge=0, le=MAX_CONTEXT_LINES)) -> dict[str, Any]:
    row = read_run(run_id)
    report = row_report(row)
    if report is None:
        raise HTTPException(status_code=409, detail="Analysis has no completed report yet")
    path = validated_path(file, label="file")
    if path not in source_paths_in_report(report):
        raise HTTPException(status_code=403, detail="Source file is not referenced by this analysis report")
    if not path.is_file() or path.stat().st_size > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=404, detail="Source file is unavailable or exceeds the size limit")
    start_line = max(1, line - context)
    end_line = line + context
    result = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as source_file:
            for line_number, text in enumerate(source_file, start=1):
                if line_number >= start_line:
                    result.append({"line": line_number, "text": text.rstrip("\r\n"), "highlighted": line_number == line})
                if line_number >= end_line:
                    break
    except OSError:
        raise HTTPException(status_code=404, detail="Source file could not be read")
    if not result:
        raise HTTPException(status_code=404, detail="Requested source line is unavailable")
    return {"api_version": API_VERSION, "analysis_id": run_id, "file": str(path),
            "requested_line": line, "start_line": start_line, "end_line": result[-1]["line"], "lines": result}


@app.on_event("startup")
def initialize() -> None:
    with db_connection():
        pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("IRQGUARD_PORT", "8000")), log_level="info")
