#!/usr/bin/env python3
"""Replay a real Claude Code log in the dashboard and check how it is read.

The log was captured by running `claude -p` through proxy.py with a prompt that
launches an Explore subagent. Real Claude Code puts system-role messages inside
messages[] (environment, MCP instructions, tool additions); this test pins down
how the dashboard handles them (SPEC D5 "New", D6 block kinds), plus the thread
and subagent links seen in that run.

Test-only dependency: Playwright with Chromium (the dashboard itself still needs
nothing installed). Run:

    python3 tests/test_real_log.py [path/to/log.jsonl]

The default log lives outside the repo, in ../real-logs/ (it holds a real
system prompt, so it is not committed). Exit status is 0 only if every check passes.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
DEFAULT_LOG = REPO.parent / "real-logs" / "2026-11-03_11-04-42.jsonl"
PORT = 18442

STATE = """() => {
  const s = app.store, L = app.labels;
  return s.list.map((e) => ({
    seq: e.seq,
    raw: !e.parsed,
    roles: e.parsed ? e.parsed.messages.map((m) => m.role) : [],
    newStart: e.newStart,
    summary: s.summary(e),
    thread: e.thread ? L.get(e.thread).label : null,
    linkedBy: e.thread ? e.thread.linkedBy : null,
    parent: e.thread && e.thread.parentCall ? '#' + e.thread.parentCall.ex.seq : null,
    pending: e.parsed ? s.reply(e).blocks.filter((b) => b.kind === 'tool_call' && !s.resultFor(e, b.id)).length : 0,
  }));
}"""

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def main() -> int:
    log = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LOG).resolve()
    if not log.is_file():
        print(f"SKIP: real log not found at {log}")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copy(log, tmp)  # the dashboard only ever reads it; a copy keeps the original untouched
        server = subprocess.Popen([sys.executable, str(REPO / "dashboard.py"), "--port", str(PORT), "--log-dir", tmp],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        try:
            time.sleep(0.8)
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                page = browser.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(f"http://127.0.0.1:{PORT}/?log={log.name}")
                page.wait_for_function("() => app.caughtUp && app.store.list.length > 0", timeout=15000)
                page.wait_for_timeout(500)
                run(page, page.evaluate(STATE))
                check("no page errors", not errors, str(errors[:3]))
                browser.close()
        finally:
            server.terminate()
            server.wait()
    print("OK" if not failures else f"{failures} check(s) failed")
    return 1 if failures else 0


def run(page, reqs: list[dict]) -> None:
    model = [r for r in reqs if not r["raw"]]
    firsts = [r for r in model if r["thread"] and r is next(x for x in model if x["thread"] == r["thread"])]

    # The fixture really has the shape this test is about.
    check("fixture: first requests carry a system-role message after the user turn",
          all(r["roles"][-1] == "system" and "user" in r["roles"] for r in firsts), str([r["roles"] for r in firsts]))

    # D5: New on a thread's first request starts at the final user-role message.
    for r in firsts:
        last_user = max(i for i, role in enumerate(r["roles"]) if role == "user")
        check(f"#{r['seq']} New starts at final user message ({last_user}) and keeps what follows",
              r["newStart"] == last_user, f"newStart={r['newStart']} roles={r['roles']}")

    # Tree summaries: actual role, typed user text when there is any, harness: for system-role text.
    sums = {r["seq"]: r["summary"] for r in model}
    check("no summary labels system-role text as user", not any('user: "system' in s or 'user: "# ' in s for s in sums.values()), str(sums))
    main_first = firsts[0]
    check("main's first request summarised by the typed prompt",
          sums[main_first["seq"]].startswith('user: "Use the Agent tool'), sums[main_first["seq"]])
    harness_only = [r for r in model if r["seq"] != main_first["seq"] and "harness:" in r["summary"]]
    check("a new part with only harness text besides tool results is summarised as harness: ...",
          bool(harness_only) and all('user: "' not in r["summary"] for r in harness_only), str(sums))

    # D6: system-role blocks rendered as their own kind, never as user text.
    page.evaluate(f"() => app.select(app.store.list[{main_first['seq'] - 1}].id, {{manual: true, reveal: true}})")
    page.wait_for_timeout(300)
    new_sec = page.evaluate("""() => {
      const sec = document.querySelector('.sec[data-key=new]');
      const blocks = [...sec.querySelectorAll('.blk')];
      return {
        harness: blocks.filter((b) => b.classList.contains('kind-harness')).map((b) => b.querySelector('.blk-label').textContent),
        userTextWithEnv: blocks.filter((b) => b.classList.contains('kind-user') && /# Environment/.test(b.textContent)).length,
        typed: blocks.some((b) => b.classList.contains('kind-user') && /Use the Agent tool/.test(b.textContent)),
        roles: [...sec.querySelectorAll('.msg-role')].map((x) => x.textContent),
      };
    }""")
    check("New shows the system-role message as a 'harness / system-role' block",
          bool(new_sec["harness"]) and all(h.startswith("⚑harness / system-role") for h in new_sec["harness"]), str(new_sec))
    check("New never shows system-role text as user text", new_sec["userTextWithEnv"] == 0, str(new_sec))
    check("New includes the typed user prompt", new_sec["typed"], str(new_sec))
    check("New role headers say harness / system-role, not system", all(not x.startswith("system") for x in new_sec["roles"]), str(new_sec["roles"]))
    hist = page.inner_text(".sec[data-key=history] .sec-head")
    check("History of a first request is empty", "none (first request)" in hist, hist)

    # Regression: threads, subagent link and tool pairing seen in this run.
    threads = {}
    for r in model:
        threads.setdefault(r["thread"], []).append(r)
    sub = [t for t in threads if t and t.startswith("subagent")]
    check("one main thread and one Explore subagent thread", "main" in threads and sub == ["subagent · Explore"], str(list(threads)))
    if sub:
        s0 = threads[sub[0]][0]
        check("subagent linked to the parent's Agent call by prompt text",
              s0["linkedBy"] == "text" and s0["parent"] == f"#{main_first['seq']}", str(s0))
    check("every tool call has its result", sum(r["pending"] for r in model) == 0)
    check("HEAD probe listed under other / raw", any(r["raw"] for r in reqs))


if __name__ == "__main__":
    sys.exit(main())
