#!/usr/bin/env python3
"""dashboard.py: live agent-traffic dashboard server for Lab 4 (SPEC D1, D3, D4).

Standard library only. Serves the static page in web/, lists the proxy's logs,
and streams log lines to the browser over Server-Sent Events. It does not
interpret traffic: every parsing rule lives in the browser (web/adapter.js).

    python3 dashboard.py                    # http://127.0.0.1:8042
    python3 dashboard.py --port 9001 --log-dir logs

Endpoints
    GET /                     the page (web/index.html and friends)
    GET /api/logs             runs, newest first: name, start, size, exchanges
    GET /api/prices           prices.json
    GET /download?log=<name>  the log file as stored (export run, SPEC D9); a live log
                              is cut at its last complete line
    GET /events?log=<name>    SSE: the whole log, then live lines as they are appended.
                              Each line is sent with `id: <byte offset>`, so an
                              EventSource that reconnects resumes where it left off.
                              Extra events: `caughtup`, `logs` (run list changed),
                              `prices` (prices.json changed).
"""

from __future__ import annotations

import argparse
import json
import re
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
PRICES = HERE / "prices.json"
LOG_DIR = HERE / "logs"

NAME_RE = re.compile(r"^[\w.-]+\.jsonl$")
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}
REQUEST_MARK = b'{"type":"request"'

# Incremental exchange counts per log: name -> (size, mtime, offset, count, partial)
_counts: dict[str, tuple] = {}
_counts_lock = threading.Lock()


def exchange_count(path: Path) -> int:
    """Count request events, reading only bytes added since the last call."""
    st = path.stat()
    with _counts_lock:
        size, mtime, offset, count, partial = _counts.get(path.name, (0, 0, 0, 0, b""))
        if st.st_size < offset:  # truncated or replaced: start again
            offset, count, partial = 0, 0, b""
        if st.st_size != offset:
            with open(path, "rb") as f:
                f.seek(offset)
                data = partial + f.read()
            offset = st.st_size
            lines = data.split(b"\n")
            partial = lines.pop()
            count += sum(1 for ln in lines if ln.startswith(REQUEST_MARK))
        _counts[path.name] = (st.st_size, st.st_mtime, offset, count, partial)
        return count


def list_logs() -> list[dict]:
    runs = []
    if LOG_DIR.is_dir():
        for p in LOG_DIR.glob("*.jsonl"):
            if not NAME_RE.match(p.name):
                continue
            try:
                st = p.stat()
                count = exchange_count(p)
            except OSError:
                continue
            try:
                start = datetime.strptime(p.name[:19], "%Y-%m-%d_%H-%M-%S").timestamp()
            except ValueError:
                start = st.st_mtime
            runs.append({"name": p.name, "start": start, "size": st.st_size,
                         "mtime": st.st_mtime, "exchanges": count})
    runs.sort(key=lambda r: (r["start"], r["name"]), reverse=True)
    return runs


def log_path(name: str) -> Path | None:
    """A log file by name, or None unless the name is valid and resolves inside LOG_DIR.

    The `.jsonl` extension may be left off: `2026-11-03_10-14-03` finds `2026-11-03_10-14-03.jsonl`.
    """
    if name and not name.endswith(".jsonl"):
        name += ".jsonl"
    if not NAME_RE.match(name):
        return None
    root = LOG_DIR.resolve()
    path = (root / name).resolve()  # follows symlinks: a link pointing outside is refused
    if path.parent != root or not path.is_file():
        return None
    return path


def log_names() -> list[str]:
    return sorted((p.name for p in LOG_DIR.glob("*.jsonl") if NAME_RE.match(p.name)), reverse=True) \
        if LOG_DIR.is_dir() else []


def prices_mtime() -> float:
    try:
        return PRICES.stat().st_mtime
    except OSError:
        return 0.0


def read_prices() -> bytes:
    try:
        data = PRICES.read_bytes()
        json.loads(data)
        return data
    except (OSError, ValueError) as e:
        return json.dumps({"_error": f"prices.json unreadable: {e}"}).encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "agent-dashboard"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass

    def send_bytes(self, status: int, data: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        if url.path == "/api/logs":
            self.send_bytes(200, json.dumps(list_logs()).encode(), MIME[".json"])
        elif url.path == "/api/prices":
            self.send_bytes(200, read_prices(), MIME[".json"])
        elif url.path == "/events":
            name = parse_qs(url.query).get("log", [""])[0]
            self.stream(name)
        elif url.path == "/download":
            name = parse_qs(url.query).get("log", [""])[0]
            self.download(name)
        else:
            self.static(url.path)

    def static(self, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB / rel).resolve()
        if WEB.resolve() not in target.parents or not target.is_file():
            self.send_bytes(404, b"not found", "text/plain")
            return
        self.send_bytes(200, target.read_bytes(), MIME.get(target.suffix, "application/octet-stream"))

    # --- Export run (SPEC D9) ------------------------------------------------

    def download(self, name: str) -> None:
        """The log byte for byte, cut at the last complete line if it is still being written."""
        path = log_path(name)
        if path is None:
            self.send_bytes(404, b"no such log", "text/plain")
            return
        try:
            data = path.read_bytes()
        except OSError:
            self.send_bytes(404, b"no such log", "text/plain")
            return
        data = data[: data.rfind(b"\n") + 1]  # drop a partial last line (live run); no-op for a finished one
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    # --- Server-Sent Events -------------------------------------------------

    def sse(self, data: bytes) -> None:
        self.wfile.write(data)
        self.wfile.flush()

    def stream(self, name: str) -> None:
        path = log_path(name)
        if path is None:
            self.send_bytes(404, b"no such log", "text/plain")
            return
        try:
            offset = int(self.headers.get("Last-Event-ID") or 0)
        except ValueError:
            offset = 0
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        try:
            f = open(path, "rb")
        except OSError:
            return
        try:
            f.seek(offset)
            hello = {"log": name, "resume": offset > 0}
            self.sse(b"event: hello\ndata: " + json.dumps(hello).encode() + b"\n\n")
            partial = b""
            caught_up = False
            names = log_names()
            pmtime = prices_mtime()
            last_check = last_ping = time.monotonic()
            while True:
                data = f.read(1 << 20)
                if data:
                    data = partial + data
                    lines = data.split(b"\n")
                    partial = lines.pop()
                    out = []
                    pos = offset
                    for ln in lines:
                        pos += len(ln) + 1
                        ln = ln.rstrip(b"\r")
                        if ln:
                            out.append(b"id: %d\ndata: %s\n\n" % (pos, ln))
                    offset = pos
                    if out:
                        self.sse(b"".join(out))
                    continue  # keep draining before sleeping
                if not caught_up:
                    self.sse(b"event: caughtup\ndata: {}\n\n")
                    caught_up = True
                now = time.monotonic()
                if now - last_check >= 1.0:
                    last_check = now
                    new_names = log_names()
                    if new_names != names:
                        names = new_names
                        self.sse(b"event: logs\ndata: " + json.dumps(list_logs()).encode() + b"\n\n")
                    m = prices_mtime()
                    if m != pmtime:
                        pmtime = m
                        self.sse(b"event: prices\ndata: " + read_prices().replace(b"\n", b" ") + b"\n\n")
                if now - last_ping >= 15:
                    last_ping = now
                    self.sse(b": ping\n\n")
                time.sleep(0.15)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            f.close()


def main() -> None:
    global LOG_DIR
    parser = argparse.ArgumentParser(description="Live dashboard for the Lab 4 proxy's traffic logs.")
    parser.add_argument("--port", type=int, default=8042)
    parser.add_argument("--log-dir", default=str(HERE / "logs"), help="directory of proxy logs (default: logs/)")
    args = parser.parse_args()
    LOG_DIR = Path(args.log_dir).resolve()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"dashboard on http://127.0.0.1:{args.port}  (logs: {LOG_DIR})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
