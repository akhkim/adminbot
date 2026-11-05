#!/usr/bin/env python3
"""Share AdminBot's model GPU with other jobs while the model is idle; AdminBot has priority.

Three commands, one file, standard library only (it runs under whatever python3 Aurora has):

  gate     The loopback front door on 127.0.0.1:8000 that AdminBot already calls. vLLM itself
           listens on a Unix socket in a private directory with sleep mode on. The gate forwards
           only /health and /v1/*; everything else is 404, which matters because sleep mode
           needs VLLM_SERVER_DEV_MODE, and dev mode adds unauthenticated control endpoints
           (/collective_rpc, /update_weights, /sleep, ...) that any user on this shared host
           could otherwise reach. After GATE_IDLE_SECONDS without a request the gate puts the
           model to sleep (level 1: weights to host RAM, GPU memory released). The next /v1
           request preempts any registered borrowers, waits for the GPU to empty, wakes the
           model, and only then is forwarded.

  borrow   `borrow -- <command...>` waits until the model is asleep, then runs the command in its
           own process group and registers it, so the gate can stop it: SIGTERM first (time to
           checkpoint), SIGKILL after GATE_PREEMPT_GRACE_SECONDS. A job that must not be cut off
           mid-step should checkpoint on SIGTERM.

  preempt  Stops every registered borrower and waits. Run before vLLM starts, so a model restart
           never fights a borrower for memory.

The gate and borrow share one lock file, so a borrower cannot start between the gate deciding to
wake the model and the wake itself, and the gate cannot wake into a borrower that is just
starting. All state lives under GATE_RUNTIME_DIR, created 0700: only this account can register a
borrower, read the state, or reach the vLLM socket.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import http.client
import http.server
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Iterator

# ---------------------------------------------------------------------------------------------
# Configuration


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


def default_runtime_base() -> str:
    """Where the per-user runtime directory lives when GATE_RUNTIME_DIR is not set.

    XDG_RUNTIME_DIR first; then /run/user/<uid>, which is what systemd's %t names and is present
    whenever the user manager runs -- a non-interactive ssh session often has no XDG_RUNTIME_DIR,
    and falling straight to /tmp made `status` read an empty directory and report "down" while
    the gate was serving. /tmp only when neither exists.
    """
    xdg = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    if xdg:
        return xdg
    run_user = f"/run/user/{os.getuid()}"
    if os.path.isdir(run_user):
        return run_user
    return f"/tmp/jinesis-gpu-share-{os.getuid()}"


def runtime_dir() -> Path:
    base = os.environ.get("GATE_RUNTIME_DIR") or os.path.join(default_runtime_base(), "jinesis-gpu7")
    path = Path(base)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    (path / "borrowers").mkdir(mode=0o700, exist_ok=True)
    return path


def vllm_socket() -> str:
    return os.environ.get("VLLM_UDS") or str(runtime_dir() / "vllm.sock")


STATE_AWAKE = "awake"
STATE_SLEEPING = "sleeping"
STATE_WAKING = "waking"
STATE_GOING_TO_SLEEP = "going-to-sleep"
STATE_DOWN = "down"

# Hop-by-hop headers are the connection's, not the request's.
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
}


# ---------------------------------------------------------------------------------------------
# Shared lock, state file and borrower registry


@contextlib.contextmanager
def share_lock() -> Iterator[None]:
    with open(runtime_dir() / "lock", "a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def write_state(state: str) -> None:
    target = runtime_dir() / "state"
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps({"state": state, "since": time.time()}))
    os.replace(temp, target)


def read_state() -> str:
    try:
        return json.loads((runtime_dir() / "state").read_text()).get("state", STATE_DOWN)
    except (OSError, ValueError):
        return STATE_DOWN


def _alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Not ours to signal; nothing this account registered.
        return False


def registered_borrowers() -> list[tuple[Path, int]]:
    found = []
    for entry in (runtime_dir() / "borrowers").glob("*.json"):
        try:
            pgid = int(json.loads(entry.read_text())["pgid"])
        except (OSError, ValueError, KeyError):
            entry.unlink(missing_ok=True)
            continue
        if _alive(pgid):
            found.append((entry, pgid))
        else:
            entry.unlink(missing_ok=True)
    return found


def preempt_borrowers(grace_seconds: int, log: Callable[[str], None] = print) -> int:
    """SIGTERM every registered borrower group, SIGKILL what is left after the grace period."""
    borrowers = registered_borrowers()
    for _entry, pgid in borrowers:
        log(f"preempting borrower process group {pgid} (SIGTERM)")
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pgid, signal.SIGTERM)
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline and any(_alive(pgid) for _e, pgid in borrowers):
        time.sleep(0.5)
    for entry, pgid in borrowers:
        if _alive(pgid):
            log(f"borrower process group {pgid} ignored SIGTERM; SIGKILL")
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(pgid, signal.SIGKILL)
        entry.unlink(missing_ok=True)
    return len(borrowers)


def gpu_free_mib(gpu_uuid: str) -> int | None:
    """Free memory on the GPU, or None when it cannot be read (then the caller does not wait)."""
    if not gpu_uuid:
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=uuid,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 2 and parts[0] == gpu_uuid:
            return int(parts[1])
    return None


# ---------------------------------------------------------------------------------------------
# Talking to vLLM over its Unix socket


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 600.0) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


def vllm_call(method: str, path: str, timeout: float = 600.0) -> tuple[int, bytes]:
    conn = UnixHTTPConnection(vllm_socket(), timeout=timeout)
    try:
        conn.request(method, path)
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def vllm_is_sleeping() -> bool | None:
    try:
        status, body = vllm_call("GET", "/is_sleeping", timeout=10)
    except OSError:
        return None
    if status != 200:
        return None
    return bool(json.loads(body or b"{}").get("is_sleeping"))


# ---------------------------------------------------------------------------------------------
# The gate


class Gate:
    def __init__(self) -> None:
        self.idle_seconds = _env_int("GATE_IDLE_SECONDS", 900)
        self.grace_seconds = _env_int("GATE_PREEMPT_GRACE_SECONDS", 90)
        self.wake_free_mib = _env_int("GATE_WAKE_FREE_MIB", 70000)
        self.wake_timeout = _env_int("GATE_WAKE_TIMEOUT_SECONDS", 300)
        self.gpu_uuid = os.environ.get("GATE_GPU_UUID", "").strip()
        self.cond = threading.Condition()
        self.state = STATE_DOWN
        self.inflight = 0
        self.last_activity = time.monotonic()
        self.wake_error: str | None = None

    def log(self, message: str) -> None:
        print(f"[gate] {message}", flush=True)

    def _set(self, state: str) -> None:
        self.state = state
        write_state(state)
        self.cond.notify_all()

    def refresh_from_vllm(self) -> None:
        sleeping = vllm_is_sleeping()
        with self.cond:
            if self.state in (STATE_WAKING, STATE_GOING_TO_SLEEP):
                return
            target = STATE_DOWN if sleeping is None else (STATE_SLEEPING if sleeping else STATE_AWAKE)
            if target != self.state:
                if target == STATE_AWAKE and self.state == STATE_DOWN:
                    # A fresh vLLM counts as active now, so it is not put straight back to sleep.
                    self.last_activity = time.monotonic()
                self._set(target)

    def acquire(self) -> None:
        """Make sure the model is awake and count one request in flight; raises when it cannot."""
        with self.cond:
            while True:
                if self.state == STATE_AWAKE:
                    self.inflight += 1
                    self.last_activity = time.monotonic()
                    return
                if self.state == STATE_SLEEPING:
                    self._set(STATE_WAKING)
                    break
                if self.state == STATE_DOWN:
                    raise RuntimeError("the model server is not running")
                # Waking, or on its way to sleep: wait for it to settle.
                if not self.cond.wait(timeout=self.wake_timeout + self.grace_seconds):
                    raise RuntimeError("timed out waiting for the model to settle")
                if self.wake_error and self.state == STATE_SLEEPING:
                    raise RuntimeError(self.wake_error)
        # This thread is the waker.
        error = None
        try:
            with share_lock():
                stopped = preempt_borrowers(self.grace_seconds, self.log)
                if stopped:
                    self.log(f"preempted {stopped} borrower(s) for an AdminBot request")
                self._wait_for_gpu()
                status, body = vllm_call("POST", "/wake_up", timeout=self.wake_timeout)
                if status != 200:
                    raise RuntimeError(f"vLLM refused to wake ({status}): {body[:200]!r}")
                if vllm_is_sleeping():
                    raise RuntimeError("vLLM still reports sleeping after /wake_up")
        except Exception as exc:  # noqa: BLE001 - reported to every waiting request
            error = f"could not wake the model: {exc}"
        with self.cond:
            if error:
                self.log(error)
                self.wake_error = error
                self._set(STATE_SLEEPING)
                raise RuntimeError(error)
            self.wake_error = None
            self.log("model awake")
            self.inflight += 1
            self.last_activity = time.monotonic()
            self._set(STATE_AWAKE)

    def _wait_for_gpu(self) -> None:
        deadline = time.monotonic() + 60
        while True:
            free = gpu_free_mib(self.gpu_uuid)
            if free is None or free >= self.wake_free_mib:
                return
            if time.monotonic() > deadline:
                raise RuntimeError(f"only {free} MiB free on the GPU after preempting borrowers")
            time.sleep(1)

    def release(self) -> None:
        with self.cond:
            self.inflight -= 1
            self.last_activity = time.monotonic()
            self.cond.notify_all()

    def maybe_sleep(self) -> None:
        with self.cond:
            idle = time.monotonic() - self.last_activity
            if self.state != STATE_AWAKE or self.inflight > 0 or idle < self.idle_seconds:
                return
            self._set(STATE_GOING_TO_SLEEP)
        ok = False
        try:
            with share_lock():
                status, body = vllm_call("POST", "/sleep?level=1", timeout=self.wake_timeout)
                ok = status == 200
                if not ok:
                    self.log(f"vLLM refused to sleep ({status}): {body[:200]!r}")
        except OSError as exc:
            self.log(f"could not put the model to sleep: {exc}")
        with self.cond:
            if ok:
                self.log(f"model asleep after {int(idle)}s idle; the GPU is free for borrowers")
                self._set(STATE_SLEEPING)
            else:
                self._set(STATE_AWAKE)

    def background(self, stop: threading.Event) -> None:
        while not stop.wait(15):
            try:
                self.refresh_from_vllm()
                self.maybe_sleep()
            except Exception as exc:  # noqa: BLE001 - the loop must survive one bad tick
                self.log(f"background tick failed: {exc}")


def make_handler(gate: Gate) -> type[http.server.BaseHTTPRequestHandler]:
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "jinesis-gpu-gate"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass  # Request lines would put model traffic in the journal; nothing to keep.

        def _deny(self, status: int, message: str) -> None:
            body = json.dumps({"error": {"message": message}}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def _handle(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/health":
                needs_model = False
            elif path.startswith("/v1/"):
                needs_model = True
            else:
                # Includes every dev-mode control endpoint: this is the only way in from TCP.
                self._deny(404, "not found")
                return
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                self._deny(411, "a Content-Length is required")
                return
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            if needs_model:
                try:
                    gate.acquire()
                except RuntimeError as exc:
                    self._deny(503, str(exc))
                    return
            try:
                self._forward(body)
            finally:
                if needs_model:
                    gate.release()

        def _forward(self, body: bytes | None) -> None:
            conn = UnixHTTPConnection(vllm_socket())
            try:
                headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
                conn.request(self.command, self.path, body=body, headers=headers)
                upstream = conn.getresponse()
            except OSError as exc:
                conn.close()
                self._deny(502, f"model server unreachable: {exc}")
                return
            try:
                self.send_response(upstream.status)
                for key, value in upstream.getheaders():
                    if key.lower() not in HOP_BY_HOP and key.lower() != "content-length":
                        self.send_header(key, value)
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Connection", "close")
                self.end_headers()
                # read1 returns what has arrived, so streamed tokens are passed on as they come.
                while True:
                    chunk = upstream.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # The client went away; nothing to tell it.
            finally:
                conn.close()
                self.close_connection = True

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _handle  # noqa: N815

    return Handler


def run_gate(host: str, port: int) -> None:
    runtime_dir()
    gate = Gate()
    gate.refresh_from_vllm()
    write_state(gate.state)
    server = http.server.ThreadingHTTPServer((host, port), make_handler(gate))
    server.daemon_threads = True
    stop = threading.Event()
    threading.Thread(target=gate.background, args=(stop,), daemon=True).start()
    gate.log(f"listening on {host}:{port}, model socket {vllm_socket()}, idle sleep after {gate.idle_seconds}s")
    try:
        server.serve_forever()
    finally:
        stop.set()


# ---------------------------------------------------------------------------------------------
# borrow / preempt


def run_borrow(command: list[str], poll_seconds: int, max_wait: int) -> int:
    if not command:
        print("borrow: give the command after --", file=sys.stderr)
        return 2
    waited = 0
    while True:
        with share_lock():
            if read_state() == STATE_SLEEPING:
                child = subprocess.Popen(command, start_new_session=True)
                entry = runtime_dir() / "borrowers" / f"{child.pid}.json"
                entry.write_text(
                    json.dumps({"pgid": child.pid, "command": command[:6], "started": time.time()})
                )
                break
        if max_wait and waited >= max_wait:
            print("borrow: the model stayed busy; giving up", file=sys.stderr)
            return 75
        if waited == 0:
            print("borrow: AdminBot's model is using the GPU; waiting until it is idle", file=sys.stderr)
        time.sleep(poll_seconds)
        waited += poll_seconds

    def forward(signum: int, _frame: object) -> None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signum)

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, forward)
    try:
        code = child.wait()
    finally:
        entry.unlink(missing_ok=True)
    if code in (-signal.SIGTERM, -signal.SIGKILL, 128 + signal.SIGTERM, 128 + signal.SIGKILL):
        print("borrow: stopped so AdminBot could use the GPU", file=sys.stderr)
    return code if code >= 0 else 128 - code


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    gate_cmd = sub.add_parser("gate")
    gate_cmd.add_argument("--host", default="127.0.0.1")
    gate_cmd.add_argument("--port", type=int, default=8000)
    borrow_cmd = sub.add_parser("borrow")
    borrow_cmd.add_argument("--poll-seconds", type=int, default=15)
    borrow_cmd.add_argument("--max-wait-seconds", type=int, default=0, help="0 waits forever")
    borrow_cmd.add_argument("rest", nargs=argparse.REMAINDER)
    sub.add_parser("preempt")
    sub.add_parser("status")
    args = parser.parse_args(argv)
    if args.command == "gate":
        if args.host not in ("127.0.0.1", "::1", "localhost"):
            print("gate: refusing to listen beyond loopback", file=sys.stderr)
            return 2
        run_gate(args.host, args.port)
        return 0
    if args.command == "borrow":
        rest = args.rest[1:] if args.rest[:1] == ["--"] else args.rest
        return run_borrow(rest, args.poll_seconds, args.max_wait_seconds)
    if args.command == "preempt":
        with share_lock():
            stopped = preempt_borrowers(_env_int("GATE_PREEMPT_GRACE_SECONDS", 90))
        print(f"preempt: stopped {stopped} borrower(s)")
        return 0
    if args.command == "status":
        print(json.dumps({"state": read_state(), "borrowers": [p for _e, p in registered_borrowers()]}))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
