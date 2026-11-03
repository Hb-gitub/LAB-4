#!/usr/bin/env python3
"""proxy.py: the naive agent-traffic proxy for Lab 4.

A reverse proxy that prints every request and response and forwards them
unchanged. Standard library only; nothing to install.

    python3 proxy.py                       # listens on http://localhost:8041
    ANTHROPIC_BASE_URL=http://localhost:8041 claude

Everything Claude Code sends to the API now passes through this program and is
printed to the terminal. The proxy changes nothing: headers go through untouched
(a subscription login needs its bearer token and its `anthropic-beta` header),
and the reply is streamed back byte for byte as it arrives.

    python3 proxy.py --port 9000
    python3 proxy.py --upstream https://chatgpt.com/backend-api/codex   # for Codex
    python3 proxy.py --log-dir /tmp/agent-logs

Every exchange is also appended, raw, to logs/<YYYY-MM-DD_HH-MM-SS>.jsonl (one
file per proxy run) for dashboard.py to read. Credentials are redacted before
anything is written. A failed write prints a warning and never stops forwarding.
"""

from __future__ import annotations

import argparse
import codecs
import http.client
import json
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

# Headers that describe one hop of the connection, not the message. They are
# never forwarded. `accept-encoding` is dropped too, so the API answers in plain
# text and what we print is readable.
SKIP = {
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailers",
    "upgrade", "proxy-authorization", "proxy-authenticate", "accept-encoding",
    "content-length",
}

UPSTREAM = "https://api.anthropic.com"

# Headers whose values are replaced before they reach the log (never even a prefix).
REDACT = {"authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"}


class TrafficLog:
    """Append-only JSON-lines log of raw exchanges (SPEC D1, D3).

    Events: run (once), then request / chunk* / end per exchange, sharing an id.
    Writing must never break forwarding: any error becomes a printed warning.
    """

    def __init__(self, log_dir: Path) -> None:
        self.lock = threading.Lock()
        self.file = None
        self.path = None
        self.warned = False
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            base = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            path, n = log_dir / f"{base}.jsonl", 1
            while path.exists():
                n += 1
                path = log_dir / f"{base}-{n}.jsonl"
            self.file = open(path, "a", encoding="utf-8")
            self.path = path
        except OSError as e:
            print(f"!!! warning: cannot open traffic log in {log_dir}: {e} (forwarding continues)", flush=True)

    def write(self, event: dict) -> None:
        if self.file is None:
            return
        try:
            line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
            with self.lock:
                self.file.write(line + "\n")
                self.file.flush()
        except Exception as e:  # noqa: BLE001 - logging must never break the proxy
            if not self.warned:
                print(f"\n!!! warning: traffic log write failed: {e} (forwarding continues)", flush=True)
                self.warned = True


LOG: TrafficLog | None = None


def log_event(event: dict) -> None:
    if LOG is not None:
        LOG.write(event)


def redacted(pairs) -> list[list[str]]:
    return [[k, "<redacted>" if k.lower() in REDACT else v] for k, v in pairs]


def body_fields(body: bytes) -> dict:
    """Raw body for the log: JSON as-is, otherwise text, otherwise base64."""
    if not body:
        return {}
    try:
        return {"body": json.loads(body)}
    except ValueError:
        pass
    try:
        return {"body_text": body.decode("utf-8")}
    except UnicodeDecodeError:
        import base64
        return {"body_b64": base64.b64encode(body).decode("ascii")}


def stamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


class Tap(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # we print our own lines

    def do_POST(self) -> None:
        self.relay()

    def do_GET(self) -> None:
        self.relay()

    def do_HEAD(self) -> None:
        self.relay()

    def relay(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        xid = uuid.uuid4().hex[:12]
        log_event({"type": "request", "id": xid, "time": time.time(), "method": self.command,
                   "path": self.path, "headers": redacted(self.headers.items()), **body_fields(body)})
        try:
            self.forward(xid, body)
        except Exception as e:
            log_event({"type": "end", "id": xid, "time": time.time(), "status": None,
                       "headers": [], "error": f"{type(e).__name__}: {e}"})
            raise

    def forward(self, xid: str, body: bytes) -> None:

        # 1. Print what the agent sent.
        print(f"\n{'=' * 78}\n[{stamp()}] >>> {self.command} {self.path}", flush=True)
        for name, value in self.headers.items():
            if name.lower() in ("authorization", "x-api-key"):
                value = value[:16] + "..."
            print(f"    {name}: {value}")
        if body:
            try:
                print(json.dumps(json.loads(body), indent=2, ensure_ascii=False))
            except ValueError:
                print(body.decode("utf-8", "replace"))

        # 2. Forward it, headers intact.
        target = urlsplit(UPSTREAM)
        conn_cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        # Connect with a short timeout (a lost SYN must not stall the agent for
        # minutes); the long timeout is for reading a slow stream.
        upstream = conn_cls(target.netloc, timeout=10)
        try:
            upstream.connect()
        except OSError as e:
            print(f"\n[{stamp()}] !!! cannot reach {UPSTREAM}: {e}", flush=True)
            self.send_error(502, f"proxy: cannot reach {UPSTREAM}: {e}")
            self.close_connection = True
            log_event({"type": "end", "id": xid, "time": time.time(), "status": 502,
                       "headers": [], "error": f"cannot reach {UPSTREAM}: {e}"})
            return
        upstream.sock.settimeout(600)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in SKIP}
        upstream.request(self.command, target.path.rstrip("/") + self.path, body=body or None, headers=headers)
        reply = upstream.getresponse()

        # 3. Stream the reply back as it arrives, printing it on the way.
        print(f"\n[{stamp()}] <<< {reply.status} {reply.reason}", flush=True)
        self.send_response(reply.status, reply.reason)
        for name, value in reply.getheaders():
            if name.lower() not in SKIP and name.lower() != "content-encoding":
                self.send_header(name, value)
        self.send_header("Connection", "close")
        self.end_headers()
        reply_headers = redacted(reply.getheaders())
        if self.command == "HEAD":
            self.close_connection = True
            log_event({"type": "end", "id": xid, "time": time.time(), "status": reply.status,
                       "headers": reply_headers, "error": None})
            return
        # Incremental decoder: a UTF-8 character split across two chunks is not mangled in the log.
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while chunk := reply.read1(4096):  # read1: pass on each chunk as it lands, don't wait for 4096 bytes
            self.wfile.write(chunk)
            self.wfile.flush()
            sys.stdout.write(chunk.decode("utf-8", "replace"))
            sys.stdout.flush()
            if text := decoder.decode(chunk):
                log_event({"type": "chunk", "id": xid, "time": time.time(), "data": text})
        if tail := decoder.decode(b"", final=True):
            log_event({"type": "chunk", "id": xid, "time": time.time(), "data": tail})
        self.close_connection = True
        log_event({"type": "end", "id": xid, "time": time.time(), "status": reply.status,
                   "headers": reply_headers, "error": None})
        print(f"\n[{stamp()}] --- done", flush=True)


def main() -> None:
    global UPSTREAM, LOG
    parser = argparse.ArgumentParser(description="Print and forward an agent's API traffic.")
    parser.add_argument("--port", type=int, default=8041)
    parser.add_argument("--upstream", default=UPSTREAM, help="where to forward (default: the Anthropic API)")
    parser.add_argument("--log-dir", default=str(Path(__file__).resolve().parent / "logs"),
                        help="where to write the per-run traffic log (default: logs/ next to proxy.py)")
    args = parser.parse_args()
    UPSTREAM = args.upstream.rstrip("/")
    LOG = TrafficLog(Path(args.log_dir))
    log_event({"type": "run", "id": "run", "time": time.time(), "upstream": UPSTREAM, "port": args.port})
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Tap)
    print(f"proxy listening on http://localhost:{args.port}  ->  {UPSTREAM}")
    print(f"run the agent with:  ANTHROPIC_BASE_URL=http://localhost:{args.port} claude")
    if LOG.path:
        print(f"logging traffic to {LOG.path}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
