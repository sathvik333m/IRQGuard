#!/usr/bin/env python3
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
sys.path.insert(0, str(BACKEND))
from irqguard_api import main as api_module  # noqa: E402

ANALYZER = Path(sys.argv[1]).resolve()
INTERRUPT_FIXTURE = Path(sys.argv[2]).resolve()


def free_port():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def api_request(port, route, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{route}", data=body,
        headers={"Content-Type": "application/json"} if body else {},
        method="POST" if body else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


class LocalApiIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="irqguard-api-")
        cls.root = Path(cls.temporary.name).resolve()
        cls.source = cls.root / "interrupts.c"
        shutil.copyfile(INTERRUPT_FIXTURE, cls.source)
        cls.invalid_source = cls.root / "invalid.c"
        cls.invalid_source.write_text("int broken(void) { return ; syntax_error\n", encoding="utf-8")
        cls.wrong_type = cls.root / "notes.txt"
        cls.wrong_type.write_text("not C", encoding="utf-8")
        cls.database = cls.root / "compile-db"
        cls.database.mkdir()
        (cls.database / "compile_commands.json").write_text(json.dumps([{
            "directory": str(cls.root), "file": str(cls.source),
            "arguments": ["clang", "-std=c11", "-c", str(cls.source)],
        }]), encoding="utf-8")
        cls.port = free_port()
        environment = os.environ.copy()
        python_deps = environment.get("IRQGUARD_TEST_PYTHONPATH", "")
        environment["PYTHONPATH"] = os.pathsep.join(filter(None, [str(BACKEND), python_deps]))
        environment["IRQGUARD_ANALYZER"] = str(ANALYZER)
        environment["IRQGUARD_WORKSPACES"] = str(cls.root)
        environment["IRQGUARD_DATA_DIR"] = str(cls.root / "state")
        environment["IRQGUARD_PORT"] = str(cls.port)
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "irqguard_api.main:app", "--host", "127.0.0.1", "--port", str(cls.port)],
            cwd=BACKEND, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        for _ in range(100):
            if cls.server.poll() is not None:
                raise RuntimeError(f"Backend failed to start: {cls.server.stderr.read()}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/api/v1/health", timeout=0.2):
                    break
            except Exception:
                time.sleep(0.1)
        else:
            cls.server.kill()
            raise RuntimeError("Backend did not become healthy")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=4)
        except subprocess.TimeoutExpired:
            cls.server.kill()
        cls.temporary.cleanup()

    def test_health_reports_real_capabilities_and_allowed_root(self):
        status, body = api_request(self.port, "/api/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["analyzer_report_schema"], 3)
        self.assertTrue(body["analyzer_available"])
        self.assertEqual(body["workspace_roots"], [str(self.root)])
        self.assertFalse(body["runtime_evidence_available"])
        self.assertFalse(body["benchmarks_available"])

    def test_valid_analysis_persists_actual_report_and_source_evidence(self):
        status, queued = api_request(self.port, "/api/v1/analyses", {
            "source_path": str(self.source),
            "compile_commands_path": str(self.database / "compile_commands.json"),
        })
        self.assertEqual(status, 202, queued)
        run_id = queued["id"]
        for _ in range(300):
            status, metadata = api_request(self.port, f"/api/v1/analyses/{run_id}")
            self.assertEqual(status, 200)
            state = metadata["analysis"]["status"]
            if state in {"completed", "failed"}:
                break
            time.sleep(0.1)
        self.assertEqual(state, "completed", metadata)
        self.assertGreater(metadata["analysis"]["duration_ms"], 0)
        self.assertEqual(metadata["analysis"]["analyzer_schema_version"], 3)

        status, report = api_request(self.port, f"/api/v1/analyses/{run_id}/report")
        self.assertEqual(status, 200)
        self.assertEqual(report["schema_version"], 3)
        self.assertGreater(len(report["functions"]), 0)
        self.assertGreater(len(report["interrupt_lock_graph"]["edges"]), 0)

        status, graph = api_request(self.port, f"/api/v1/analyses/{run_id}/graph")
        self.assertEqual(status, 200)
        self.assertEqual(len(graph["edges"]), len(report["interrupt_lock_graph"]["edges"]))
        status, findings = api_request(self.port, f"/api/v1/analyses/{run_id}/findings")
        self.assertEqual(status, 200)
        self.assertEqual(len(findings["findings"]), len(report["interrupt_cycles"]))
        self.assertTrue(findings["findings"][0]["finding_id"].startswith(run_id[:8]))

        edge = report["interrupt_lock_graph"]["edges"][0]
        location = edge.get("from_location", {}).get("expansion", {})
        query = urllib.parse.urlencode({"file": str(self.source), "line": location.get("line", 1), "context": 1})
        status, snippet = api_request(self.port, f"/api/v1/analyses/{run_id}/source?{query}")
        self.assertEqual(status, 200)
        self.assertTrue(any(line["highlighted"] for line in snippet["lines"]))
        self.assertTrue(snippet["lines"])

        status, runs = api_request(self.port, "/api/v1/analyses")
        self.assertEqual(status, 200)
        self.assertTrue(any(item["id"] == run_id for item in runs["analyses"]))

    def test_paths_are_confined_and_inputs_are_validated(self):
        outside = {"source_path": "/etc/passwd"}
        status, body = api_request(self.port, "/api/v1/analyses", outside)
        self.assertEqual(status, 403, body)

        link = self.root / "outside.c"
        try:
            link.symlink_to("/etc/passwd")
        except OSError:
            self.skipTest("Symlinks are not available in this workspace")
        status, body = api_request(self.port, "/api/v1/analyses", {"source_path": str(link)})
        self.assertEqual(status, 403, body)

        status, body = api_request(self.port, "/api/v1/analyses", {"source_path": str(self.wrong_type)})
        self.assertEqual(status, 400, body)
        status, body = api_request(self.port, "/api/v1/analyses", {"source_path": "relative.c"})
        self.assertEqual(status, 400, body)
        status, body = api_request(self.port, "/api/v1/analyses", {
            "source_path": str(self.source), "unexpected_shell": "touch /tmp/nope",
        })
        self.assertEqual(status, 422, body)

    def test_compile_database_and_source_range_limits(self):
        status, body = api_request(self.port, "/api/v1/analyses", {
            "source_path": str(self.source), "compile_commands_path": str(self.root / "missing-db"),
        })
        self.assertEqual(status, 400, body)

        status, queued = api_request(self.port, "/api/v1/analyses", {"source_path": str(self.source)})
        self.assertEqual(status, 202, queued)
        for _ in range(300):
            status, metadata = api_request(self.port, f"/api/v1/analyses/{queued['id']}")
            if metadata["analysis"]["status"] in {"completed", "failed"}:
                break
            time.sleep(0.1)
        query = urllib.parse.urlencode({"file": str(self.source), "line": 1, "context": 1000})
        status, body = api_request(self.port, f"/api/v1/analyses/{queued['id']}/source?{query}")
        self.assertEqual(status, 422, body)

    def test_parser_failure_is_saved_as_failed_not_as_a_successful_report(self):
        status, queued = api_request(self.port, "/api/v1/analyses", {"source_path": str(self.invalid_source)})
        self.assertEqual(status, 202, queued)
        for _ in range(200):
            status, metadata = api_request(self.port, f"/api/v1/analyses/{queued['id']}")
            if metadata["analysis"]["status"] in {"completed", "failed"}:
                break
            time.sleep(0.1)
        self.assertEqual(metadata["analysis"]["status"], "failed")
        self.assertTrue(metadata["analysis"]["error"])
        status, body = api_request(self.port, f"/api/v1/analyses/{queued['id']}/report")
        self.assertEqual(status, 409, body)

    def test_backend_process_timeout_and_output_limits(self):
        previous_timeout = api_module.RUN_TIMEOUT_SECONDS
        previous_limit = api_module.MAX_STREAM_BYTES
        try:
            api_module.RUN_TIMEOUT_SECONDS = 1
            _, _, _, timeout_error = api_module.read_process(
                [sys.executable, "-c", "import time; time.sleep(4)"], REPO,
            )
            self.assertIn("timeout", timeout_error.lower())
            api_module.RUN_TIMEOUT_SECONDS = 5
            api_module.MAX_STREAM_BYTES = 256
            _, _, _, output_error = api_module.read_process(
                [sys.executable, "-c", "print('x' * 1000)"], REPO,
            )
            self.assertIn("output limit", output_error.lower())
        finally:
            api_module.RUN_TIMEOUT_SECONDS = previous_timeout
            api_module.MAX_STREAM_BYTES = previous_limit


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
