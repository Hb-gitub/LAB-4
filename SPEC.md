# SPEC: Live Agent-Traffic Dashboard

Status: **ready for review**. All design decisions (D1–D8) are settled. No code yet.

## 1. Purpose

A browser dashboard for watching, live, the traffic between a coding agent (Claude Code, possibly Codex)
and the model API as it passes through the Lab 4 proxy (`proxy.py`). It shows what the agent sends:
system prompt, tools, history and the new turn. It also shows what the model replies, and how tool
calls connect to the results that come back in later requests.

## 2. Context: what the proxy sees

- `proxy.py` is a stdlib-only reverse proxy on `localhost:8041`. It forwards to
  `https://api.anthropic.com` by default, or to `--upstream` (e.g. the Codex backend).
- Every call to the model is a full, stateless request. The `system`, `tools` and complete
  `messages` history are re-sent every time, so the "new" part of a request is only what was
  added since the previous request in the same conversation.
- Replies are streamed (SSE). The final message is not present in any single chunk.
  It has to be rebuilt from `message_start` / `content_block_*` / `message_delta` events,
  and usage arrives split between `message_start` and `message_delta`.
- A tool call appears in reply *N* as a `tool_use` block with an `id`. Its result appears in
  request *N+1* as a `tool_result` block with the same `tool_use_id`.
- The agent also makes side calls that are not the main conversation: title or summary
  generation on a small model, token counting, subagents running in parallel, and HEAD/GET probes.
- The `authorization` / `x-api-key` headers carry live credentials.

## 3. Core requirements (from the brief)

| # | Requirement |
|---|-------------|
| R1 | Show requests and responses as they happen, newest first. |
| R2 | Break each request into: full system instructions, tool definitions, conversation history, the new message. |
| R3 | Show each tool call side by side with its result (which arrives in a later request). |
| R4 | Show model replies: text and requested tool calls. |
| R5 | Readable UX: collapsible long text, formatted JSON, clear visual distinction between parts. |
| R6 | Statistics (tokens, time, cost, tool breakdown) as a complement to the message drill-down, not a replacement. |

## 4. Decisions

### D1. Data path: proxy writes a log, dashboard tails it

```
agent ──► proxy.py ──► API
             │ append
             ▼
        traffic.jsonl
             │ tail
             ▼
     dashboard server ──SSE──► browser
```

- `proxy.py` keeps forwarding exactly as it does today. The only addition is appending JSON-lines
  events to a log file. Writing to the log must never block or break forwarding: if a write
  fails, print a warning and carry on.
- The proxy logs **raw** data and does no interpretation. It is the dashboard's job to parse
  messages, rebuild streams and pair tool calls with results. This keeps the proxy change
  small and lets the dashboard's parsing be fixed and re-run on old logs.
- Events per exchange, all sharing one exchange `id`:
  - `request`: time, method, path, headers, body. `authorization`, `x-api-key`, `cookie`, `set-cookie`
    and `proxy-authorization` are replaced with `"<redacted>"` before writing, so the log never holds
    credentials, not even a prefix. The proxy's terminal output redacts the same headers.
  - `chunk`: time, raw bytes of each streamed piece as it is relayed, so the dashboard can show a
    reply while it is still being written. The bytes are decoded incrementally as UTF-8, so a
    character split across chunks stays intact. Bytes that aren't valid UTF-8 are stored as base64
    with an encoding marker.
  - `end`: time, status, response headers, and an error if the upstream failed. If the upstream
    fails at any point after connecting, an `end` event with `error` is still written.
- Time, method, path, status and headers are plain JSON.
- The dashboard server runs as its own process and can be started, stopped or restarted
  without affecting the agent. On connect, a browser receives the existing log first and
  then live events.

### D2. Formats: Anthropic Messages now, behind an adapter

- v1 fully understands the **Anthropic Messages API** (`POST /v1/messages`, SSE streaming), which is
  what Claude Code sends.
- All format knowledge lives in an **adapter** that turns one raw exchange (request, chunks, end)
  into a neutral model. The UI and the statistics only ever see that neutral model:

  | Neutral field | Anthropic source |
  |---|---|
  | `model` | `body.model` |
  | `system[]`: text blocks | `body.system` (string or block list) |
  | `tools[]`: name, description, input schema | `body.tools` |
  | `messages[]`: role, content blocks | `body.messages` |
  | content block kinds: `text`, `thinking`, `tool_call{id,name,input}`, `tool_result{call_id,content,is_error}`, `image`, `harness`, `other` | `text`, `thinking`, `tool_use`, `tool_result`, `image`, blocks of system-role messages, anything else |
  | `reply`: content blocks, `stop_reason` | rebuilt from SSE `message_start` / `content_block_*` / `message_delta` |
  | `usage`: input, output, cache-read, cache-write tokens | `message_start.usage` + `message_delta.usage` |

- Adding Codex later (OpenAI Responses: `instructions`, `input` items, `function_call` /
  `function_call_output`) only takes a second adapter. No UI changes.
- Traffic that no adapter recognises (other paths, HEAD/GET probes, non-JSON bodies) is still
  listed and shown as raw, formatted JSON or text. Nothing is dropped silently.
- A reply that isn't `text/event-stream` is parsed as one JSON message. A non-2xx reply is a JSON
  error and shows as an error in the tree.
- `/v1/messages/count_tokens` is a side call and is never priced.
- Real Claude Code puts system-role messages inside `messages[]` (environment, MCP instructions,
  tool additions). They are their own block kind, `harness`, and are never shown as user text.

### D3. Persistence: one log per proxy run, past runs browsable

- Each proxy start creates `logs/<YYYY-MM-DD_HH-MM-SS>.jsonl` next to `proxy.py`. A `--log-dir`
  flag overrides the location.
- By default the dashboard follows the **newest** log live. A run picker lists earlier logs,
  newest first, with start time, size and exchange count, and opens any of them **read-only**.
- When a new log appears (the proxy was restarted), the dashboard offers to switch to it. It
  doesn't jump on its own, so you don't lose your place.
- Logs are never deleted by the tool. Cleaning them up is manual.
- Because the log is the source of truth, reloading the browser or restarting the dashboard
  rebuilds the full view from the log with nothing lost.

### D4. Stack: Python stdlib + plain HTML/CSS/JS, nothing to install

- **Server** (`dashboard.py`): Python 3 standard library only, the same constraint as `proxy.py`.
  It serves the static page, lists the logs, and streams log events to the browser over
  Server-Sent Events (`GET /events?log=<name>`). Run with `python3 dashboard.py [--port 8042] [--log-dir logs]`.
  It binds to `127.0.0.1` only.
- **Page**: static HTML, CSS and vanilla JS (ES modules). No npm, no build step, no CDN, and
  it works offline. Widgets such as the collapsible JSON tree and the diff view are written in-house.
- **Where parsing runs**: the adapter (D2) runs **in the browser**. The server only passes log
  lines through, so it stays dumb and every interpretation rule lives in one place.
- **Safety**: all captured content is untrusted (tool results can contain arbitrary HTML,
  including prompt-injection text). It is always inserted as text (`textContent`), never as HTML.

### D5. Grouping: threads by history prefix

**Matching rule.** Let `expected(P)` = `P.messages` followed by `P.reply` as an assistant message.
A new request `R` **continues** thread `T` if `R.messages` begins with `expected(last request of T)`.
The comparison is on normalised content: `cache_control` markers are ignored, and so are keys in
a fixed ignore-list, which is extended when real traffic shows a field that changes harmlessly.
A string `content` equals a list holding one text block with the same text. `signature`,
`citations`, thinking blocks and empty text blocks are also ignored.
If several threads match, the longest match wins, then the most recently active thread.
If none match, `R` starts a new thread. An identical retry after a failed request continues the
same thread.

**"New message" (R2).** For a continuing request, the new part is the messages after the matched
prefix, usually one user message holding tool results and/or typed text. For a thread's first
request, it starts at the final user-role message. Everything before that counts as *history*.

**Thread labels** are guessed automatically and can be renamed in the UI:
- **main**: the thread with the largest tool set, whatever its model.
- **subagent · <type>**: a thread that starts while another thread has an unanswered
  subagent-launching tool call (e.g. `Agent`/`Task`). The label is taken from that call's input, and the
  thread is linked to it. In R3 the parent's tool call opens the subagent thread, and
  the subagent's final reply is shown as the result.
- **side call · <model>**: a thread with no tools, or a single request on a small model (model id
  contains `haiku`): title generation, summaries, token counting.

**Subagent linking.** An `Agent`/`Task` call counts as pending once its `tool_use` block has
finished streaming. A new thread is linked to the call whose prompt text appears in its first user
message. Otherwise, if exactly one call is pending, it is linked to that call and marked *"linked by
timing"*. If several are pending, it is not linked and is marked *"possible subagent of <thread>"*.
Calls in a failed reply are dropped.

**Breaks in the chain.** If history is rewritten (e.g. context compaction), the next request
won't match, so it starts a new thread. When its system prompt and tools match an existing
thread, it is marked *"possible continuation of <thread>"* with a link. The two threads are never
merged silently.

**Ordering.** Threads are listed by most recent activity, and each thread lists its requests
newest first (R1). The thread with an in-flight request shows a live indicator.

**Tool pairing (R3).** Each `tool_call` id is matched to the `tool_result` with the same id in a
later request of the same thread. Until that request arrives, the call is shown as *pending*.

### D6. Layout: two panes, list on the left and detail on the right

```
┌ [run ▾]  [search]           ┬ request #14 · main · Fable 5.1 · 2.1s · $0.04 · 200 ┐
│ ▼ main            ● live    │ ▸ System       3 blocks · 4,342 words · unchanged  │
│   #14 ← Bash result         │ ▸ Tools        24 · Bash Read Edit … · unchanged   │
│   #13 ← Read result         │ ▸ History      26 messages                         │
│   #12 user: "fix the…"      │ ▼ New          2 tool results                      │
│ ▸ subagent · Explore (6)    │ ▼ Reply        text + 1 tool call · end_turn       │
│ ▸ side call · haiku (1)     │ ▼ Tool calls   Edit(file.py) ↔ result in #15       │
│ ▸ other / raw (3)           │ ▸ Raw          request · response · headers        │
└─────────────────────────────┴────────────────────────────────────────────────────┘
```

**Left pane: thread tree.**
- Threads are ordered as in D5. Each request row shows its number, a one-line summary of its new
  part (e.g. `← Bash result`, `user: "fix the…"`), status (streaming / done / error) and duration.
  The summary uses the message's actual role (`harness: …` for system-role blocks).
- Thread renames are kept in the browser, per log.
- An **other / raw** group at the bottom holds exchanges that no adapter recognised.
- **Follow live** is on by default: the newest request is selected automatically as it arrives.
  Selecting anything by hand pauses following, and a "↑ N new · resume live" pill brings it back.
- Search filters requests by any text in their new part, reply or tool calls.

**Right pane: request detail.** It is made of sections in a fixed order. Each section header
shows a one-line summary and expands or collapses on click.

| Section | Default | Content |
|---|---|---|
| **System** | collapsed | Each system block in order, as plain text with whitespace kept. Header badge: *unchanged* / *changed* compared with the previous request in the thread. If changed, a word-level diff toggle. |
| **Tools** | collapsed | One row per tool: name and the first line of its description. Expand a row for the full description and the input schema as a JSON tree. Same *unchanged/changed* badge, plus which tools were added or removed. |
| **History** | collapsed | The earlier messages as a compact transcript. Each message collapses to one line, and tool calls/results inside it are paired as in the Tool calls section. |
| **New** | expanded | The new part (D5): typed user text, and tool results, each labelled with the call it answers (`↩ Bash #13`). |
| **Reply** | expanded | Assistant text (markdown shown as text with light formatting), thinking (collapsed, dimmed), and tool calls (name + input JSON tree). It fills in live while streaming, with a cursor. Footer: stop reason and usage. |
| **Tool calls** | expanded | The R3 view. One row per call in this reply, with the **call** (name, input) on the left and the **result** (content, error state) on the right. The result arrives in a later request, and until then it shows *pending…*. The row links to the request that holds the result. Subagent calls link to their thread. |
| **Raw** | collapsed | Request body, response headers and the raw SSE stream, as JSON trees or text, each with a copy button. |

**Readability rules (R5).**
- **Long text**: anything over ~20 lines or ~2,000 characters is cut to a preview with
  "show all (N lines)". Expanding renders lazily, so a 50 kB system prompt costs nothing until opened.
- **JSON**: shown as a collapsible tree with syntax colouring. Objects deeper than two levels start
  collapsed. Every value has a copy button. JSON hidden inside strings (e.g. a tool result that is
  JSON text) is detected and offered as "view as JSON".
- **Visual distinction**: each block kind has a fixed colour and icon, used the same way everywhere:
  system, tool definition, user text, assistant text, thinking, tool call, tool result, tool error
  (red), and harness tags such as `<system-reminder>` (highlighted inside text, since they are
  injected by the agent rather than typed by the user).
- Dark and light themes follow the OS setting.

### D7. Cost: an API-equivalent estimate from an editable price table

- Cost is always labelled **"API-equivalent estimate"**, never "cost" alone. On a subscription login
  no money is charged per request. The estimate shows what the traffic would cost at API list prices,
  which makes the effect of caching visible.
- Prices live in `prices.json` next to `dashboard.py`. The file is edited by hand and reloaded
  whenever it changes. Each entry gives a model-id prefix and USD per million tokens for `input`,
  `output`, `cache_read` and `cache_write`. The longest matching prefix wins (so a dated model id
  matches its family entry). The file is filled with current published prices when it is
  implemented. The spec doesn't fix the numbers.
- `cost = Σ tokens_kind × price_kind / 1e6` over the four token kinds from the reply's usage (D2).
- If no entry matches, tokens are still shown and the cost reads *"price unknown"*. That request is
  left out of cost totals, and the total is marked *"excludes N requests"*.
- Shown per request (detail header and Reply footer), per thread and per run.

### D8. Statistics: a summary strip plus a Stats tab, both linked to the drill-down

**Summary strip** (always visible, top of the page, for the current run and filter):
requests · input / output tokens · cache-hit % · wall time · API-equivalent estimate.

**Stats tab** (swaps out the right pane; the thread tree stays, and the Detail tab is one click back):
- **Over time**: per-request bars for tokens (stacked: uncached input, cache read, cache write,
  output) and for latency. One bar per request, coloured by thread.
- **Per thread**: requests, tokens, time and estimate for each thread.
- **Tool breakdown**: per tool name, the number of calls, errors (`is_error`), average and max
  *round-trip* time, and average result size.
- **Per model**: requests, tokens and estimate for each model.
- Every bar and row links back: clicking it filters the thread tree to those requests and opens the first.

**Metric definitions.**
- *Latency* = `end.time − request.time`. *Time to first token* = first `chunk.time − request.time`.
- *Tool round-trip* = start of the request carrying the result − end of the reply that made the
  call. This includes tool run time, permission prompts and agent overhead, and is labelled that way.
- *Cache-hit %* = `cache_read / (input + cache_read + cache_write)`.
- *Wall time* in the strip = earliest request start to latest reply end. In the per-thread table,
  time = sum of latencies, labelled that way.
- Charts are inline SVG built by the page (D4: no libraries), with the same block-kind colours as D6.

## 5. Out of scope (v1)

- Changing, replaying or blocking traffic. The dashboard only watches.
- The Codex / OpenAI Responses adapter (D2 leaves room for it).
- Authentication or remote access. Both servers bind to `127.0.0.1`.
- Deleting or rotating logs.

## 6. Files

```
proxy.py        # as supplied, plus JSON-lines logging (D1, D3)
dashboard.py    # stdlib server: static files, log list, SSE stream (D4)
prices.json     # editable price table (D7)
web/            # index.html, style.css, *.js (adapter, threading, views)
logs/           # one .jsonl per proxy run (D3)
```

## 7. Acceptance checks

1. With proxy and dashboard running, a new Claude Code prompt appears at the top of the tree
   within 1 s, and its reply streams into the Reply section as it is written.
2. For any request, System / Tools / History / New add up to exactly the request body (nothing
   missing, nothing doubled), as checked against the Raw section.
3. Every tool call in a reply shows its result once the following request arrives. An Explore
   subagent shows up as its own thread, linked from the parent's call.
4. A 4,000-word system prompt and a 24-tool definition list open collapsed, and the page
   stays responsive on a run of 200+ requests.
5. Restarting the dashboard, or reloading the page, rebuilds the same view from the log.
6. No credential, not even a prefix, appears in the log or the UI.
7. Token totals in the strip equal the sum of the per-request usage. Cost totals are marked as
   estimates and list any excluded requests.
8. A multi-byte character split across chunks displays correctly.
9. A subagent whose first request arrives before the parent's reply ends is still linked to the
   parent's call.
10. On a real Claude Code first request, "New" shows the typed prompt, not a harness block.
11. A non-2xx reply shows as an error in the tree.

## 8. Open decisions

_None. All decisions are recorded in §4._
