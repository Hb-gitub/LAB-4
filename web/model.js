// The store: raw log events in, exchanges + threads out (SPEC D1, D5, D7).
// Events are processed strictly in log order, so replaying a log always
// rebuilds exactly the same view (acceptance check 5).

import { adapterFor } from './adapter.js';
import { hash } from './util.js';

// Tool names that launch a subagent (SPEC D5).
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

// Keys ignored when comparing history for thread matching. Extend this list
// when real traffic shows a field that changes harmlessly between requests.
export const IGNORE_KEYS = new Set(['cache_control', 'signature', 'citations']);

// ------------------------------------------------------------ fingerprints

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).filter((k) => !IGNORE_KEYS.has(k)).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

// Normalised fingerprint of one neutral block. Thinking and empty text are
// skipped: agents may drop them when re-sending history.
function blockFp(b) {
  switch (b.kind) {
    case 'text': { const t = b.text.trim(); return t ? 't' + t : null; }
    case 'thinking': return null;
    case 'tool_call': return 'c' + b.id + '\u0002' + b.name + '\u0002' + stable(b.input);
    case 'tool_result': return 'r' + b.call_id + (b.is_error ? '!' : '') + '\u0002' + b.content.map(blockFp).filter(Boolean).join('\u0003');
    case 'image': return 'i' + b.media_type + b.size;
    default: return 'o' + stable(b.raw);
  }
}

export function messageHash(role, blocks) {
  return hash(role + '\u0001' + blocks.map(blockFp).filter(Boolean).join('\u0001'));
}

// ------------------------------------------------------------------ prices

export function priceFor(prices, model) {
  if (!prices || !model) return null;
  let best = null, bestLen = -1;
  for (const [prefix, p] of Object.entries(prices)) {
    if (prefix.startsWith('_') || typeof p !== 'object' || !p) continue;
    if (model.startsWith(prefix) && prefix.length > bestLen) { best = p; bestLen = prefix.length; }
  }
  return best;
}

// API-equivalent estimate (SPEC D7). null = price unknown.
export function costOf(prices, model, usage) {
  if (!usage) return null;
  const p = priceFor(prices, model);
  if (!p) return null;
  return ((usage.input || 0) * (p.input || 0) + (usage.output || 0) * (p.output || 0) +
    (usage.cache_read || 0) * (p.cache_read || 0) + (usage.cache_write || 0) * (p.cache_write || 0)) / 1e6;
}

// ------------------------------------------------------------------- store

export class Store {
  constructor() {
    this.reset();
  }

  reset() {
    this.exchanges = new Map(); // id -> exchange
    this.list = []; // exchanges in request order
    this.threads = []; // conversation + side threads
    this.raw = []; // exchanges no adapter recognised
    this.run = null;
    this.seq = 0;
    this.threadSeq = 0;
    this.pendingSubagent = []; // [{thread, ex, call}] unanswered subagent launches
    this.version = 0;
    this.changed = new Set();
    this.structural = false;
  }

  ingest(ev) {
    switch (ev.type) {
      case 'run': this.run = ev; break;
      case 'request': this.onRequest(ev); break;
      case 'chunk': this.onChunk(ev); break;
      case 'end': this.onEnd(ev); break;
      default: break;
    }
  }

  // ----- request
  onRequest(ev) {
    const ex = {
      id: ev.id, seq: ++this.seq, req: ev, t0: ev.time * 1000,
      chunks: [], firstChunkT: null, end: null, tEnd: null,
      adapter: null, parsed: null, rs: null, replyCache: null,
      thread: null, newStart: 0, msgHashes: null, replyHash: null, search: null,
    };
    this.exchanges.set(ex.id, ex);
    this.list.push(ex);
    this.version++;
    this.structural = true;
    this.changed.add(ex.id);

    const adapter = adapterFor(ev);
    if (adapter) {
      try {
        ex.parsed = adapter.parseRequest(ev);
        ex.adapter = adapter;
        ex.rs = adapter.newReply();
      } catch (e) {
        console.warn('adapter failed, showing raw', e);
        ex.parsed = null;
      }
    }
    if (!ex.adapter) { this.raw.push(ex); return; }

    const p = ex.parsed;
    ex.msgHashes = p.messages.map((m) => messageHash(m.role, m.blocks));
    ex.systemHash = hash(p.system.map((s) => s.text).join('\u0001'));
    ex.toolHashes = new Map(p.tools.map((t) => [t.name, hash(stable(t.raw))]));
    ex.toolsHash = hash([...ex.toolHashes.entries()].map(([k, v]) => k + ':' + v).join('|'));

    if (p.kind === 'count_tokens') {
      this.newThread(ex, { side: 'count_tokens' });
      ex.newStart = Math.max(0, p.messages.length - 1);
      return;
    }
    this.assignThread(ex);
  }

  assignThread(ex) {
    const h = ex.msgHashes;
    let best = null, bestLen = -1;
    for (const t of this.threads) {
      if (t.sideKind === 'count_tokens') continue;
      const last = t.requests[t.requests.length - 1];
      const len = this.continues(h, last);
      if (len < 0) continue;
      if (len > bestLen || (len === bestLen && t.lastT > best.lastT)) { best = t; bestLen = len; }
    }
    const n = ex.parsed.messages.length;
    if (best) {
      ex.newStart = bestLen < n ? bestLen : Math.max(0, n - 1);
      this.addToThread(best, ex);
    } else {
      ex.newStart = Math.max(0, n - 1);
      const t = this.newThread(ex, {});
      this.linkNewThread(t, ex);
    }
    this.pairResults(ex.thread, ex);
  }

  // Length of the matched prefix if `h` continues the request `last`, else -1.
  continues(h, last) {
    if (!last.msgHashes) return -1;
    const prev = last.msgHashes;
    const candidates = [];
    if (last.replyHash != null) candidates.push([...prev, last.replyHash]);
    // A request whose reply failed or was cut off is usually retried as-is.
    if (last.end && (last.replyHash == null || last.end.status >= 400 || last.end.error)) candidates.push(prev);
    for (const exp of candidates) {
      if (exp.length === 0 || h.length < exp.length) continue;
      let ok = true;
      for (let i = exp.length - 1; i >= 0; i--) if (h[i] !== exp[i]) { ok = false; break; }
      if (ok) return exp.length;
    }
    return -1;
  }

  newThread(ex, { side }) {
    const t = {
      id: ex.id, num: ++this.threadSeq, requests: [], sideKind: side || null,
      startT: ex.t0, lastT: ex.t0, parentCall: null, possibleContinuationOf: null,
      calls: new Map(), // call id -> {call, ex}
      results: new Map(), // call id -> {block, ex}
      subagents: new Map(), // call id -> child thread
      model: ex.parsed.model, maxTools: 0,
    };
    this.threads.push(t);
    this.addToThread(t, ex);
    return t;
  }

  addToThread(t, ex) {
    ex.thread = t;
    t.requests.push(ex);
    t.lastT = Math.max(t.lastT, ex.t0);
    t.model = ex.parsed.model;
    t.maxTools = Math.max(t.maxTools, ex.parsed.tools.length);
  }

  // A new thread: is it a subagent of a pending Agent/Task call, or a
  // possible continuation (after compaction) of an existing thread?
  linkNewThread(t, ex) {
    const p = ex.parsed;
    if (p.tools.length > 0 && this.pendingSubagent.length) {
      const firstUser = p.messages.find((m) => m.role === 'user');
      const text = firstUser ? firstUser.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n') : '';
      let pick = this.pendingSubagent.findIndex(({ call }) => {
        const prompt = typeof call.input?.prompt === 'string' ? call.input.prompt.trim() : '';
        return prompt && text.includes(prompt.slice(0, 200));
      });
      if (pick < 0 && !this.pendingSubagent.some(({ call }) => typeof call.input?.prompt === 'string')) pick = 0;
      if (pick >= 0) {
        const link = this.pendingSubagent.splice(pick, 1)[0];
        t.parentCall = link;
        link.thread.subagents.set(link.call.id, t);
        return;
      }
    }
    if (p.tools.length > 0) {
      for (let i = this.threads.length - 2; i >= 0; i--) {
        const o = this.threads[i];
        if (o.sideKind || o.parentCall) continue;
        const r = o.requests[o.requests.length - 1];
        if (r.systemHash === ex.systemHash && r.toolsHash === ex.toolsHash) {
          t.possibleContinuationOf = o;
          break;
        }
      }
    }
  }

  pairResults(t, ex) {
    const msgs = ex.parsed.messages;
    for (let i = ex.newStart; i < msgs.length; i++) {
      for (const b of msgs[i].blocks) {
        if (b.kind !== 'tool_result' || t.results.has(b.call_id)) continue;
        t.results.set(b.call_id, { block: b, ex });
        const k = this.pendingSubagent.findIndex((s) => s.call.id === b.call_id);
        if (k >= 0) this.pendingSubagent.splice(k, 1);
      }
    }
  }

  // ----- chunk / end
  onChunk(ev) {
    const ex = this.exchanges.get(ev.id);
    if (!ex) return;
    ex.chunks.push(ev);
    if (ex.firstChunkT == null) ex.firstChunkT = ev.time * 1000;
    if (ex.adapter) {
      try { ex.adapter.feed(ex.rs, ev.data); } catch (e) { console.warn(e); }
      ex.replyCache = null;
      ex.search = null;
    }
    this.version++;
    this.changed.add(ex.id);
  }

  onEnd(ev) {
    const ex = this.exchanges.get(ev.id);
    if (!ex) return;
    ex.end = ev;
    ex.tEnd = ev.time * 1000;
    if (ex.thread) ex.thread.lastT = Math.max(ex.thread.lastT, ex.tEnd);
    if (ex.adapter) {
      try { ex.adapter.finish(ex.rs); } catch (e) { console.warn(e); }
      ex.replyCache = null;
      ex.search = null;
      const r = this.reply(ex);
      if (r.blocks.length && !r.error && ex.parsed.kind === 'messages') {
        ex.replyHash = messageHash('assistant', r.blocks);
        for (const b of r.blocks) {
          if (b.kind !== 'tool_call') continue;
          ex.thread.calls.set(b.id, { call: b, ex });
          if (SUBAGENT_TOOLS.has(b.name) && !ex.thread.results.has(b.id)) {
            this.pendingSubagent.push({ thread: ex.thread, ex, call: b });
          }
        }
      }
    }
    this.version++;
    this.structural = true;
    this.changed.add(ex.id);
  }

  // ----- derived data

  reply(ex) {
    if (!ex.adapter) return null;
    if (!ex.replyCache) ex.replyCache = ex.adapter.reply(ex.rs, !!ex.end);
    return ex.replyCache;
  }

  usage(ex) {
    return ex.adapter ? ex.adapter.usage(ex.rs) : null;
  }

  model(ex) {
    return ex.parsed?.model || null;
  }

  status(ex) {
    if (!ex.end) return ex.chunks.length ? 'streaming' : 'waiting';
    if (ex.end.error || (ex.end.status != null && ex.end.status >= 400)) return 'error';
    const r = this.reply(ex);
    if (r?.error) return 'error';
    return 'done';
  }

  latency(ex) {
    return ex.tEnd != null ? ex.tEnd - ex.t0 : null;
  }

  ttft(ex) {
    return ex.firstChunkT != null ? ex.firstChunkT - ex.t0 : null;
  }

  // Name of the call a tool_result answers, looked up in its thread.
  callFor(ex, callId) {
    const t = ex.thread;
    const c = t?.calls.get(callId);
    if (c) return c;
    // First request of a thread: the call may be inside its own history.
    if (ex.parsed) {
      for (const m of ex.parsed.messages) for (const b of m.blocks) if (b.kind === 'tool_call' && b.id === callId) return { call: b, ex: null };
    }
    return null;
  }

  resultFor(ex, callId) {
    return ex.thread?.results.get(callId) || null;
  }

  isLive(t) {
    return t.requests.some((r) => !r.end);
  }

  // One-line summary of the new part of a request, for the tree (SPEC D6).
  summary(ex) {
    if (!ex.adapter) return `${ex.req.method} ${ex.req.path}`;
    const p = ex.parsed;
    if (p.kind === 'count_tokens') return 'count tokens';
    const results = [], texts = [];
    for (let i = ex.newStart; i < p.messages.length; i++) {
      const m = p.messages[i];
      for (const b of m.blocks) {
        if (b.kind === 'tool_result') {
          const c = this.callFor(ex, b.call_id);
          results.push((c?.call.name || 'tool') + (b.is_error ? ' ✗' : ''));
        } else if (b.kind === 'text') {
          const t = stripHarness(b.text).trim();
          if (t) texts.push((m.role === 'user' ? '' : m.role + ': ') + t);
        }
      }
    }
    const parts = [];
    if (results.length === 1) parts.push(`← ${results[0]} result`);
    else if (results.length > 1) parts.push(`← ${results.length} results: ${[...new Set(results)].join(', ')}`);
    if (texts.length) parts.push(`user: "${texts.join(' ').replace(/\s+/g, ' ').slice(0, 80)}"`);
    if (!parts.length) return p.messages.length ? '(harness text only)' : '(no messages)';
    return parts.join(' + ');
  }

  // Text the search box matches against: new part, reply and tool calls.
  searchText(ex) {
    if (ex.search != null) return ex.search;
    const parts = [this.summary(ex)];
    if (ex.parsed) {
      for (let i = ex.newStart; i < ex.parsed.messages.length; i++) for (const b of ex.parsed.messages[i].blocks) parts.push(blockText(b));
      for (const b of this.reply(ex).blocks) parts.push(blockText(b));
    } else {
      parts.push(ex.req.path, JSON.stringify(ex.req.body ?? ex.req.body_text ?? ''));
    }
    ex.search = parts.join('\n').toLowerCase();
    return ex.search;
  }
}

export function blockText(b) {
  switch (b.kind) {
    case 'text': case 'thinking': return b.text;
    case 'tool_call': return b.name + ' ' + (b.partial ?? JSON.stringify(b.input));
    case 'tool_result': return b.content.map(blockText).join('\n');
    case 'image': return '[image]';
    default: return JSON.stringify(b.raw ?? '');
  }
}

// Tags the agent harness injects into user turns (highlighted in the UI).
export const HARNESS_TAGS = [
  'system-reminder', 'command-name', 'command-message', 'command-args', 'command-contents',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'user-prompt-submit-hook',
  'bash-input', 'bash-stdout', 'bash-stderr', 'user-memory-input', 'task-notification', 'pasted_content',
];
export const HARNESS_RE = new RegExp(`<(${HARNESS_TAGS.join('|')})(\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'g');

export function stripHarness(s) {
  return s.replace(HARNESS_RE, '');
}
