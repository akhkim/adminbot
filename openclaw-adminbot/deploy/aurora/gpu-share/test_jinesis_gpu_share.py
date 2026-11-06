"""Tests for jinesis_gpu_share.py against a fake vLLM on a Unix socket.

Run: python3 -m unittest discover -s deploy/aurora/gpu-share -p 'test_*.py'
"""

from __future__ import annotations

import http.client
import http.server
import json
import os
import shutil
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import jinesis_gpu_share as share  # noqa: E402


class FakeVllm:
    """Sleep-mode vLLM's surface: /is_sleeping, /sleep, /wake_up, /health, /v1/*."""

    def __init__(self, socket_path: str, sleeping: bool = False) -> None:
        self.sleeping = sleeping
        self.calls: list[str] = []
        self.forwarded: list[object] = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:
                pass

            def _reply(self, status: int, payload: object) -> None:
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                fake.calls.append(f"GET {self.path}")
                if self.path == "/is_sleeping":
                    self._reply(200, {"is_sleeping": fake.sleeping})
                elif self.path == "/health":
                    self._reply(200, {})
                elif self.path.startswith("/v1/"):
                    if fake.sleeping:
                        self._reply(500, {"error": "asleep"})
                    else:
                        self._reply(200, {"data": [{"id": "fake-model"}], "auth": self.headers.get("Authorization")})
                else:
                    self._reply(404, {})

            def do_POST(self) -> None:  # noqa: N802
                fake.calls.append(f"POST {self.path}")
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                if self.path.startswith("/sleep"):
                    fake.sleeping = True
                    self._reply(200, {})
                elif self.path == "/wake_up":
                    fake.sleeping = False
                    self._reply(200, {})
                elif self.path.startswith("/v1/"):
                    fake.forwarded.append(json.loads(body or b"{}"))
                    self._reply(
                        200,
                        {
                            "echo": json.loads(body or b"{}"),
                            "priority_header": self.headers.get("X-Jinesis-Priority"),
                        },
                    )
                else:
                    self._reply(200, {"reached": self.path})

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

            def get_request(self):  # type: ignore[override]
                request, _ = super().get_request()
                return request, ("local", 0)

        self.server = Server(socket_path, Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class GpuShareTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="gpus")
        self.env = {
            "GATE_RUNTIME_DIR": os.path.join(self.dir, "rt"),
            "VLLM_UDS": os.path.join(self.dir, "v.sock"),
            "GATE_IDLE_SECONDS": "900",
            "GATE_PREEMPT_GRACE_SECONDS": "2",
            "GATE_GPU_UUID": "",
        }
        self.saved = {key: os.environ.get(key) for key in self.env}
        os.environ.update(self.env)
        self.fake = FakeVllm(self.env["VLLM_UDS"])
        self.gate = share.Gate()
        self.gate.refresh_from_vllm()
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), share.make_handler(self.gate))
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]
        self.children: list[subprocess.Popen[bytes]] = []

    def tearDown(self) -> None:
        for child in self.children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        self.server.shutdown()
        self.server.server_close()
        self.fake.close()
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.dir, ignore_errors=True)

    def request(
        self, method: str, path: str, body: object | None = None, extra_headers: dict | None = None
    ) -> tuple[int, dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        payload = json.dumps(body).encode() if body is not None else None
        headers = {"Authorization": "Bearer test-key", **(extra_headers or {})}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, json.loads(data or b"{}")

    def register_borrower(self, script: str) -> tuple[subprocess.Popen[bytes], dict]:
        """Start a borrower and wait until it is ready (its signal handlers are in place).

        A thread reaps it the moment it exits, as the `borrow` wrapper does in production: an
        unreaped child is a zombie, and a zombie still answers `killpg(pgid, 0)`.
        """
        ready = os.path.join(self.dir, f"ready-{len(self.children)}")
        child = subprocess.Popen(
            [sys.executable, "-c", f"{script}\nopen({ready!r}, 'w').close()\nimport time\nwhile True: time.sleep(1)"],
            start_new_session=True,
        )
        self.children.append(child)
        result: dict = {}
        threading.Thread(target=lambda: result.setdefault("code", child.wait()), daemon=True).start()
        deadline = time.monotonic() + 10
        while not os.path.exists(ready):
            self.assertLess(time.monotonic(), deadline, "borrower never became ready")
            time.sleep(0.05)
        (Path(self.env["GATE_RUNTIME_DIR"]) / "borrowers" / f"{child.pid}.json").write_text(
            json.dumps({"pgid": child.pid})
        )
        return child, result

    # -- forwarding and the dev-mode wall ---------------------------------------------------

    def test_forwards_the_api_and_health_with_the_callers_key(self) -> None:
        status, body = self.request("GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(body["auth"], "Bearer test-key")
        status, body = self.request("POST", "/v1/chat/completions", {"messages": []})
        self.assertEqual((status, body["echo"]), (200, {"messages": []}))
        self.assertEqual(self.request("GET", "/health")[0], 200)

    def test_never_exposes_dev_mode_control_endpoints(self) -> None:
        for path in ["/collective_rpc", "/sleep?level=1", "/wake_up", "/update_weights", "/pause", "/metrics", "/"]:
            status, _ = self.request("POST", path, {})
            self.assertEqual(status, 404, path)
        self.assertNotIn("POST /collective_rpc", self.fake.calls)
        self.assertFalse(self.fake.sleeping)

    # -- sleeping when idle -----------------------------------------------------------------

    def test_puts_an_idle_model_to_sleep_and_records_it(self) -> None:
        self.gate.idle_seconds = 0
        self.gate.maybe_sleep()
        self.assertIn("POST /sleep?level=1", self.fake.calls)
        self.assertEqual(self.gate.state, share.STATE_SLEEPING)
        self.assertEqual(share.read_state(), share.STATE_SLEEPING)

    def test_does_not_sleep_with_a_request_in_flight(self) -> None:
        self.gate.idle_seconds = 0
        self.gate.acquire()
        self.gate.maybe_sleep()
        self.assertNotIn("POST /sleep?level=1", self.fake.calls)
        self.gate.release()

    # -- waking takes the GPU back --------------------------------------------------------

    def test_a_request_while_asleep_preempts_borrowers_then_wakes(self) -> None:
        self.gate.idle_seconds = 0
        self.gate.maybe_sleep()
        polite, polite_exit = self.register_borrower("pass")
        stubborn, stubborn_exit = self.register_borrower(
            "import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)"
        )
        status, body = self.request("GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(body["data"][0]["id"], "fake-model")
        polite.wait(timeout=5)
        stubborn.wait(timeout=5)
        time.sleep(0.1)
        # The polite one goes on SIGTERM; the one that ignores it is killed after the grace period.
        self.assertEqual(polite_exit["code"], -signal.SIGTERM)
        self.assertEqual(stubborn_exit["code"], -signal.SIGKILL)
        self.assertIn("POST /wake_up", self.fake.calls)
        self.assertEqual(self.gate.state, share.STATE_AWAKE)
        self.assertEqual(list((Path(self.env["GATE_RUNTIME_DIR"]) / "borrowers").glob("*.json")), [])

    def test_health_does_not_wake_the_model(self) -> None:
        self.gate.idle_seconds = 0
        self.gate.maybe_sleep()
        self.assertEqual(self.request("GET", "/health")[0], 200)
        self.assertNotIn("POST /wake_up", self.fake.calls)

    # -- borrow -------------------------------------------------------------------------

    def test_borrow_waits_while_the_model_is_in_use(self) -> None:
        share.write_state(share.STATE_AWAKE)
        started = time.monotonic()
        code = share.run_borrow([sys.executable, "-c", "pass"], poll_seconds=1, max_wait=1)
        self.assertEqual(code, 75)
        self.assertGreaterEqual(time.monotonic() - started, 1)

    def test_borrow_runs_and_unregisters_when_the_model_sleeps(self) -> None:
        share.write_state(share.STATE_SLEEPING)
        marker = os.path.join(self.dir, "ran")
        code = share.run_borrow(
            [sys.executable, "-c", f"open({marker!r}, 'w').write('ok')"], poll_seconds=1, max_wait=5
        )
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(marker))
        self.assertEqual(list((Path(self.env["GATE_RUNTIME_DIR"]) / "borrowers").glob("*.json")), [])

    def test_runtime_dir_is_private(self) -> None:
        mode = os.stat(self.env["GATE_RUNTIME_DIR"]).st_mode & 0o777
        self.assertEqual(mode, 0o700)

    def test_without_xdg_runtime_dir_it_uses_the_user_run_dir(self) -> None:
        saved = os.environ.pop("XDG_RUNTIME_DIR", None)
        try:
            expected = f"/run/user/{os.getuid()}"
            if os.path.isdir(expected):
                self.assertEqual(share.default_runtime_base(), expected)
            else:
                self.assertEqual(share.default_runtime_base(), f"/tmp/jinesis-gpu-share-{os.getuid()}")
            os.environ["XDG_RUNTIME_DIR"] = "/somewhere/xdg"
            self.assertEqual(share.default_runtime_base(), "/somewhere/xdg")
        finally:
            os.environ.pop("XDG_RUNTIME_DIR", None)
            if saved is not None:
                os.environ["XDG_RUNTIME_DIR"] = saved

    def test_gate_refuses_to_listen_beyond_loopback(self) -> None:
        self.assertEqual(share.main(["gate", "--host", "0.0.0.0", "--port", "0"]), 2)

    # -- interactive first, background (email automation) after ---------------------------

    BACKGROUND = {"X-Jinesis-Priority": "background"}

    def background_request_in_thread(self) -> dict:
        result: dict = {}

        def run() -> None:
            result["status"], result["body"] = self.request(
                "POST", "/v1/chat/completions", {"job": "email"}, self.BACKGROUND
            )
            result["at"] = time.monotonic()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        result["thread"] = thread
        return result

    def test_background_waits_while_an_interactive_request_is_in_flight(self) -> None:
        self.gate.admit(False)  # a chat.safe.eu request mid-stream
        held = self.background_request_in_thread()
        time.sleep(1.5)
        self.assertEqual(self.fake.forwarded, [], "background reached vLLM while chat was in flight")
        released_at = time.monotonic()
        self.gate.leave(False)
        held["thread"].join(timeout=10)
        self.assertEqual(held["status"], 200)
        self.assertGreaterEqual(held["at"], released_at)
        self.assertEqual(self.fake.forwarded, [{"job": "email"}])

    def test_interactive_never_waits_for_background(self) -> None:
        self.gate.admit(True)
        self.gate.admit(True)  # background at its cap
        started = time.monotonic()
        status, body = self.request("POST", "/v1/chat/completions", {"job": "chat"})
        self.assertEqual((status, body["echo"]), (200, {"job": "chat"}))
        self.assertLess(time.monotonic() - started, 1.0)
        self.gate.leave(True)
        self.gate.leave(True)

    def test_background_concurrency_is_capped(self) -> None:
        self.gate.background_max = 1
        self.gate.admit(True)
        held = self.background_request_in_thread()
        time.sleep(1.5)
        self.assertEqual(self.fake.forwarded, [])
        self.gate.leave(True)
        held["thread"].join(timeout=10)
        self.assertEqual(held["status"], 200)

    def test_a_starved_background_request_goes_ahead_alone(self) -> None:
        self.gate.background_starve_seconds = 1
        self.gate.admit(False)  # chat never goes idle
        held = self.background_request_in_thread()
        held["thread"].join(timeout=10)
        self.assertEqual(held["status"], 200)
        self.gate.leave(False)

    def test_background_gives_up_with_503_rather_than_hang(self) -> None:
        self.gate.background_starve_seconds = 60
        self.gate.background_max_wait = 1
        self.gate.admit(False)
        status, body = self.request("POST", "/v1/chat/completions", {"job": "email"}, self.BACKGROUND)
        self.gate.leave(False)
        self.assertEqual(status, 503)
        self.assertIn("busy with interactive", body["error"]["message"])
        self.assertEqual(self.fake.forwarded, [])
        self.assertEqual(self.gate.background, 0)

    def test_priority_header_is_not_forwarded_and_vllm_priority_is_opt_in(self) -> None:
        status, body = self.request("POST", "/v1/chat/completions", {"job": "email"}, self.BACKGROUND)
        self.assertEqual((status, body["echo"], body["priority_header"]), (200, {"job": "email"}, None))
        self.gate.vllm_priority = True
        status, body = self.request("POST", "/v1/chat/completions", {"job": "email"}, self.BACKGROUND)
        self.assertEqual(body["echo"], {"job": "email", "priority": 10})
        # Interactive requests keep vLLM's default priority (0, ahead of background's 10).
        status, body = self.request("POST", "/v1/chat/completions", {"job": "chat"})
        self.assertEqual(body["echo"], {"job": "chat"})
        self.assertEqual((self.gate.interactive, self.gate.background), (0, 0))

    def test_with_vllm_priority_leaves_non_objects_and_caller_priorities_alone(self) -> None:
        self.assertEqual(share.with_vllm_priority(b"not json", 10), b"not json")
        self.assertEqual(share.with_vllm_priority(b"[1]", 10), b"[1]")
        self.assertEqual(share.with_vllm_priority(b'{"priority": -1}', 10), b'{"priority": -1}')
        self.assertIsNone(share.with_vllm_priority(None, 10))

    def test_recognizes_the_email_automation_by_its_command_line(self) -> None:
        import socket

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        server_port = listener.getsockname()[1]
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import socket, sys, time\n"
                f"s = socket.create_connection(('127.0.0.1', {server_port}))\n"
                "time.sleep(30)",
                "scripts/adminbot-email-automation.ts",
            ],
            start_new_session=True,
        )
        self.children.append(child)
        try:
            listener.settimeout(10)
            conn, (_host, peer_port) = listener.accept()
            peer = share.loopback_peer(peer_port, server_port)
            self.assertIsNotNone(peer)
            self.assertEqual(peer[0], os.getuid())
            os.environ.pop("GATE_BACKGROUND_COMMANDS", None)
            self.assertTrue(share.classify_request(None, peer))
            os.environ["GATE_BACKGROUND_COMMANDS"] = "some-other-job"
            self.assertFalse(share.classify_request(None, peer))
            os.environ["GATE_BACKGROUND_COMMANDS"] = ""
            self.assertFalse(share.classify_request(None, peer))
            # Another account's caller is interactive whatever it runs; the header still demotes.
            self.assertFalse(share.classify_request(None, (os.getuid() + 1, peer[1])))
            self.assertTrue(share.classify_request("Background", None))
            self.assertFalse(share.classify_request(None, None))
            conn.close()
        finally:
            os.environ.pop("GATE_BACKGROUND_COMMANDS", None)
            listener.close()


if __name__ == "__main__":
    unittest.main()
