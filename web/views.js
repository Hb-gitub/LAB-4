// Left pane (thread tree) and right pane (request detail), SPEC D5/D6.

import { el, fmtMs, fmtUsd, fmtInt, oneLine, plural, wordCount, copyButton, fmtClock } from './util.js';
import { costOf, stripHarness } from './model.js';
import {
  section, badge, disclosure, longText, richText, jsonTree, textOrJson, wordDiff,
  blockView, callPair, resultView, ICON, plainText, HARNESS_ROLE_LABEL,
} from './widgets.js';

// ------------------------------------------------------------ thread labels

// Side call: count_tokens, a one-request tool-less thread, or a small-model
// (haiku) thread that has no tools or a single request.
export function isSideThread(t) {
  if (t.sideKind) return true;
  if (t.requests.length === 1 && t.maxTools === 0) return true;
  return /haiku/i.test(t.model || '') && (t.maxTools === 0 || t.requests.length === 1);
}

function shortModel(m) {
  return (m || '?').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// Guessed labels (SPEC D5), overridden by the user's renames.
export function threadLabels(store, renames) {
  const out = new Map();
  // main: the largest tool set, whatever the model; earliest start wins ties
  // (threads are in start order).
  let main = null;
  for (const t of store.threads) {
    if (t.parentCall || t.sideKind || t.maxTools === 0) continue;
    if (!main || t.maxTools > main.maxTools) main = t;
  }
  for (const t of store.threads) {
    let kind, label;
    if (t.sideKind === 'count_tokens') { kind = 'side'; label = 'side call · count_tokens'; }
    else if (t.parentCall) {
      const inp = t.parentCall.call.input || {};
      kind = 'subagent';
      label = 'subagent · ' + oneLine(inp.subagent_type || inp.description || t.parentCall.call.name, 40);
    } else if (t === main) { kind = 'main'; label = 'main'; }
    else if (isSideThread(t)) { kind = 'side'; label = 'side call · ' + shortModel(t.model); }
    else { kind = 'thread'; label = `thread ${t.num} · ${shortModel(t.model)}`; }
    const renamed = renames[t.id];
    out.set(t, { kind, label: renamed || label, guessed: label });
  }
  return out;
}

// ------------------------------------------------------------------- tree

function statusIcon(s) {
  return { streaming: '◌', waiting: '…', done: '✓', error: '✗' }[s] || '';
}

export function renderTree(app) {
  const { store, state } = app;
  const root = el('div', { class: 'tree' });
  const visible = app.visibleSet();
  const threads = [...store.threads].sort((a, b) => b.lastT - a.lastT);
  const selected = store.exchanges.get(state.selectedId);

  for (const t of threads) {
    const rows = [...t.requests].reverse().filter((ex) => visible.has(ex));
    if (!rows.length) continue;
    const info = app.labels.get(t);
    const live = store.isLive(t);
    const defaultOpen = info.kind === 'main' || info.kind === 'thread' || (selected && selected.thread === t);
    const open = state.threadOpen.has(t.id) ? state.threadOpen.get(t.id) : defaultOpen;
    const cost = threadCost(app, t);

    const head = el('div', { class: `t-head tk-${info.kind}` + (open ? ' open' : ''), role: 'button', tabindex: '0', title: info.label },
      el('span', { class: 'chev' }),
      el('span', { class: 'swatch', style: `background:${app.threadColor(t)}` }),
      el('span', { class: 't-label', text: info.label }),
      el('span', { class: 't-count', text: `(${t.requests.length})` }),
      live ? el('span', { class: 'live', title: 'request in flight', text: '● live' }) : null,
      el('span', { class: 't-cost', title: 'API-equivalent estimate', text: cost.text }),
      el('button', {
        class: 'icon-btn', type: 'button', title: 'Rename thread', text: '✎',
        onclick: (e) => { e.stopPropagation(); app.rename(t, info); },
      }));
    const toggle = () => { state.threadOpen.set(t.id, !open); app.renderTree(); };
    head.addEventListener('click', (e) => { if (!e.target.closest('button')) toggle(); });
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(); });

    const group = el('div', { class: 't-group' }, head);
    if (t.parentCall) {
      group.appendChild(parentNote(app, t, '↳ launched by '));
    }
    if (t.possibleSubagentOf) group.appendChild(possibleSubagentNote(app, t));
    if (t.possibleContinuationOf) {
      const o = t.possibleContinuationOf;
      group.appendChild(el('div', { class: 't-note' }, '⋯ possible continuation of ',
        app.link(o.requests[o.requests.length - 1], app.labels.get(o).label)));
    }
    if (open) for (const ex of rows) group.appendChild(requestRow(app, ex));
    root.appendChild(group);
  }

  const raws = store.raw.filter((ex) => visible.has(ex)).reverse();
  if (raws.length) {
    const open = state.threadOpen.get('__raw') ?? false;
    const head = el('div', { class: 't-head tk-raw' + (open ? ' open' : ''), role: 'button', tabindex: '0' },
      el('span', { class: 'chev' }), el('span', { class: 't-label', text: 'other / raw' }), el('span', { class: 't-count', text: `(${raws.length})` }));
    head.addEventListener('click', () => { state.threadOpen.set('__raw', !open); app.renderTree(); });
    const group = el('div', { class: 't-group' }, head);
    if (open) for (const ex of raws) group.appendChild(requestRow(app, ex));
    root.appendChild(group);
  }
  if (!root.childNodes.length) {
    root.appendChild(el('div', { class: 'empty', text: store.list.length ? 'No requests match.' : 'Waiting for traffic…  Run the agent through the proxy.' }));
  }
  return root;
}

// "launched by Agent in #6", plus "(linked by timing)" when the prompt text did not match.
function parentNote(app, t, prefix) {
  const pc = t.parentCall;
  return el('div', { class: 't-note' }, prefix, app.link(pc.ex, `${pc.call.name} in #${pc.ex.seq}`),
    t.linkedBy === 'timing'
      ? el('span', { class: 'badge warn', title: 'The prompt text did not match; this was the only pending subagent call when the thread started.', text: 'linked by timing' })
      : null);
}

// Several subagent calls were pending and none matched by prompt text: not linked.
function possibleSubagentNote(app, t) {
  const parts = [];
  t.possibleSubagentOf.forEach((o, i) => {
    if (i) parts.push(', ');
    parts.push(app.link(o.requests[o.requests.length - 1], app.labels.get(o)?.label || `thread ${o.num}`));
  });
  return el('div', { class: 't-note', title: 'Started while several subagent calls were pending; none matched by prompt text, so it is not linked.' },
    '? possible subagent of ', parts);
}

function requestRow(app, ex) {
  const { store, state } = app;
  const st = store.status(ex);
  const lat = store.latency(ex);
  const dur = lat != null ? fmtMs(lat) : fmtMs(Date.now() - ex.t0);
  const row = el('div', {
    class: `r-row st-${st}` + (ex.id === state.selectedId ? ' sel' : ''), role: 'button', tabindex: '0',
    dataset: { id: ex.id },
  },
  el('span', { class: 'r-num', text: '#' + ex.seq }),
  el('span', { class: 'r-sum', text: store.summary(ex) }),
  el('span', { class: 'r-st', title: st, text: statusIcon(st) }),
  el('span', { class: 'r-dur', text: dur }));
  row.addEventListener('click', () => app.select(ex.id, { manual: true }));
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') app.select(ex.id, { manual: true }); });
  return row;
}

export function threadCost(app, t) {
  let sum = 0, excluded = 0, any = false;
  for (const ex of t.requests) {
    const u = app.store.usage(ex);
    if (!u) continue;
    const c = costOf(app.prices, app.store.model(ex), u);
    if (c == null) excluded++; else { sum += c; any = true; }
  }
  if (!any && !excluded) return { text: '', sum: 0, excluded };
  return { text: (any ? '~' + fmtUsd(sum) : '') + (excluded ? (any ? '+' : '') + '?' : ''), sum, excluded };
}

// ----------------------------------------------------------------- detail

export function renderDetail(app, ex) {
  const root = el('div', { class: 'detail' });
  if (!ex) {
    root.appendChild(el('div', { class: 'empty', text: 'Select a request on the left.' }));
    return root;
  }
  const header = el('div', { class: 'd-header' });
  root.appendChild(header);
  const refresh = () => { header.textContent = ''; header.append(...detailHeader(app, ex)); };
  refresh();

  if (!ex.adapter) {
    const raw = rawSection(app, ex, true);
    root.appendChild(raw);
    root.update = ({ mode }) => { refresh(); if (mode !== 'other') raw.rerender(); };
    return root;
  }

  const p = ex.parsed;
  const thread = ex.thread;
  const idx = thread.requests.indexOf(ex);
  const prev = idx > 0 ? thread.requests[idx - 1] : null;
  const S = app.state.sections;

  // System
  const sysText = p.system.map((s) => s.text).join('\n\n');
  const sysWords = wordCount(sysText);
  const sysChange = !prev ? 'first in thread' : prev.systemHash === ex.systemHash ? 'unchanged' : 'changed';
  root.appendChild(section({
    key: 'system', title: [el('span', { class: 'ico', text: ICON.system }), ' System'], kind: 'system', state: S, open: false,
    summary: `${plural(p.system.length, 'block')} · ${fmtInt(sysWords)} words`,
    badges: [badge(sysChange, sysChange === 'changed' ? 'warn' : '')],
    render: () => {
      const box = el('div');
      if (sysChange === 'changed') {
        const prevText = prev.parsed.system.map((s) => s.text).join('\n\n');
        box.appendChild(disclosure(el('span', { class: 'linkish', text: 'word diff vs previous request #' + prev.seq }), () => wordDiff(prevText, sysText), { cls: 'diff-disc' }));
      }
      if (!p.system.length) box.appendChild(el('div', { class: 'dim', text: '(no system prompt)' }));
      p.system.forEach((s, i) => box.appendChild(el('div', { class: 'blk kind-system' },
        el('div', { class: 'blk-label' }, el('span', { class: 'ico', text: ICON.system }), `system block ${i + 1}`, el('span', { class: 'dim', text: ` · ${fmtInt(wordCount(s.text))} words` }), copyButton(s.text)),
        longText(s.text, { render: (t) => richText(t) }))));
      return box;
    },
  }));

  // Tools
  let toolBadges = [];
  if (!prev) toolBadges = [badge('first in thread')];
  else if (prev.toolsHash === ex.toolsHash) toolBadges = [badge('unchanged')];
  else {
    const added = [...ex.toolHashes.keys()].filter((k) => !prev.toolHashes.has(k));
    const removed = [...prev.toolHashes.keys()].filter((k) => !ex.toolHashes.has(k));
    const changed = [...ex.toolHashes.keys()].filter((k) => prev.toolHashes.has(k) && prev.toolHashes.get(k) !== ex.toolHashes.get(k));
    toolBadges = [badge('changed', 'warn')];
    if (added.length) toolBadges.push(badge('+ ' + added.join(', '), 'add'));
    if (removed.length) toolBadges.push(badge('− ' + removed.join(', '), 'del'));
    if (changed.length) toolBadges.push(badge('~ ' + changed.join(', '), 'warn'));
  }
  root.appendChild(section({
    key: 'tools', title: [el('span', { class: 'ico', text: ICON.tooldef }), ' Tools'], kind: 'tooldef', state: S, open: false,
    summary: `${p.tools.length} · ${oneLine(p.tools.map((t) => t.name).join(' '), 70)}`,
    badges: toolBadges,
    render: () => {
      const box = el('div', { class: 'tools' });
      if (!p.tools.length) box.appendChild(el('div', { class: 'dim', text: '(no tools)' }));
      for (const t of p.tools) {
        const first = (t.description.split('\n').find((l) => l.trim()) || '').trim();
        box.appendChild(disclosure(
          el('span', { class: 'tool-row' }, el('span', { class: 'ico kind-tooldef', text: ICON.tooldef }), el('b', { text: t.name }), el('span', { class: 'dim', text: ' ' + oneLine(first, 110) })),
          () => el('div', { class: 'blk kind-tooldef' },
            t.description ? longText(t.description) : el('div', { class: 'dim', text: '(no description)' }),
            el('div', { class: 'sub-label' }, 'input schema ', copyButton(() => JSON.stringify(t.schema, null, 2))),
            t.schema ? jsonTree(t.schema) : jsonTree(t.raw))));
      }
      return box;
    },
  }));

  // History
  const local = localPairs(p.messages);
  const localCtx = {
    pairCalls: true,
    resultFor: (id) => local.results.get(id) || null,
    callFor: (id) => local.calls.get(id) || null,
    link: (e2) => app.link(e2),
    subagentFor: (id) => subagentLink(app, thread, id),
  };
  root.appendChild(section({
    key: 'history', title: ' History', kind: 'history', state: S, open: false,
    summary: ex.newStart ? `${plural(ex.newStart, 'message')} (0–${ex.newStart - 1})` : 'none (first request)',
    render: () => {
      const box = el('div', { class: 'transcript' });
      for (let i = 0; i < ex.newStart; i++) box.appendChild(messageLine(p.messages[i], i, localCtx, local));
      if (!ex.newStart) box.appendChild(el('div', { class: 'dim', text: '(no earlier messages)' }));
      return box;
    },
  }));

  // New
  const newCtx = {
    pairCalls: true,
    resultFor: (id) => local.results.get(id) || null,
    callFor: (id) => app.store.callFor(ex, id),
    link: (e2) => app.link(e2),
    subagentFor: (id) => subagentLink(app, thread, id),
  };
  const newMsgs = p.messages.slice(ex.newStart);
  const nTR = newMsgs.reduce((n, m) => n + m.blocks.filter((b) => b.kind === 'tool_result').length, 0);
  const nText = newMsgs.reduce((n, m) => n + (m.role === 'system' ? 0 : m.blocks.filter((b) => b.kind === 'text').length), 0);
  const nHarness = newMsgs.filter((m) => m.role === 'system').length;
  root.appendChild(section({
    key: 'new', title: ' New', kind: 'user', state: S, open: true,
    summary: [nTR ? plural(nTR, 'tool result') : '', nText ? plural(nText, 'text block') : '', nHarness ? plural(nHarness, 'harness message') : ''].filter(Boolean).join(' + ') +
      ` · message${newMsgs.length === 1 ? '' : 's'} ${ex.newStart}–${p.messages.length - 1}`,
    render: () => {
      const box = el('div');
      newMsgs.forEach((m, k) => {
        box.appendChild(el('div', { class: 'msg-role', text: `${roleLabel(m.role)} · message ${ex.newStart + k}` }));
        for (const b of m.blocks) box.appendChild(blockView(b, m.role, newCtx));
      });
      if (!newMsgs.length) box.appendChild(el('div', { class: 'dim', text: '(empty)' }));
      return box;
    },
  }));

  // Reply
  const replySec = section({
    key: 'reply', title: [el('span', { class: 'ico', text: ICON.assistant }), ' Reply'], kind: 'assistant', state: S, open: true,
    summary: replySummary(app, ex),
    render: () => replyBody(app, ex),
  });
  root.appendChild(replySec);

  // Tool calls
  const callsSec = section({
    key: 'calls', title: [el('span', { class: 'ico', text: ICON.call }), ' Tool calls'], kind: 'call', state: S, open: true,
    summary: callsSummary(app, ex),
    render: () => callsBody(app, ex),
  });
  root.appendChild(callsSec);

  const raw = rawSection(app, ex, false);
  root.appendChild(raw);

  // mode: 'chunk' (reply grew), 'end' (reply finished), 'other' (elsewhere in the run,
  // e.g. a later request brought a tool result). Only the affected sections re-render.
  root.update = ({ mode }) => {
    refresh();
    replySec.setSummary(replySummary(app, ex));
    callsSec.setSummary(callsSummary(app, ex));
    if (mode === 'chunk' || mode === 'end') replySec.rerender();
    if (mode === 'end') raw.rerender();
    callsSec.rerender();
  };
  return root;
}

function detailHeader(app, ex) {
  const { store } = app;
  const st = store.status(ex);
  const lat = store.latency(ex);
  const parts = [el('span', { class: 'd-title', text: `request #${ex.seq}` })];
  if (ex.thread) {
    const info = app.labels.get(ex.thread);
    parts.push(' · ', el('span', { class: 'swatch', style: `background:${app.threadColor(ex.thread)}` }), info.label);
  } else parts.push(' · other / raw');
  if (ex.parsed) parts.push(' · ', el('b', { text: ex.parsed.model }));
  parts.push(' · ', lat != null ? fmtMs(lat) : el('span', { class: 'live', text: `${st} ${fmtMs(Date.now() - ex.t0)}` }));
  const u = store.usage(ex);
  if (u) {
    const c = costOf(app.prices, store.model(ex), u);
    parts.push(' · ', el('span', { title: 'API-equivalent estimate at list prices (not a charge)', text: c == null ? 'price unknown' : '~' + fmtUsd(c) + ' API-equiv.' }));
  }
  if (ex.end) parts.push(' · ', el('span', { class: ex.end.status >= 400 || ex.end.error ? 'badge err' : 'badge ok', text: String(ex.end.status ?? 'failed') }));
  const meta = [`${ex.req.method} ${ex.req.path}`, `at ${fmtClock(ex.t0)}`];
  const ttft = store.ttft(ex);
  if (ttft != null) meta.push(`first token ${fmtMs(ttft)}`);
  if (u) meta.push(`tokens in ${fmtInt(u.input)} · out ${fmtInt(u.output)} · cache read ${fmtInt(u.cache_read)} · cache write ${fmtInt(u.cache_write)}`);
  if (ex.parsed) {
    const n = ex.parsed.messages.length;
    meta.push(`body = ${ex.parsed.system.length} system + ${ex.parsed.tools.length} tools + ${ex.newStart} history + ${n - ex.newStart} new messages + ${Object.keys(ex.parsed.params).length} params`);
  }
  const lines = [el('div', { class: 'd-line1' }, parts), el('div', { class: 'd-meta', text: meta.join('  ·  ') })];
  if (ex.end?.error) lines.push(el('div', { class: 'warn', text: 'upstream error: ' + ex.end.error }));
  const t = ex.thread;
  if (t?.parentCall && t.requests[0] === ex) lines.push(parentNote(app, t, '↳ subagent launched by '));
  if (t?.possibleSubagentOf && t.requests[0] === ex) lines.push(possibleSubagentNote(app, t));
  if (t?.possibleContinuationOf && t.requests[0] === ex) {
    const o = t.possibleContinuationOf;
    lines.push(el('div', { class: 't-note' }, '⋯ possible continuation of ', app.link(o.requests[o.requests.length - 1], app.labels.get(o).label), ' (history did not match; not merged)'));
  }
  return lines;
}

function replySummary(app, ex) {
  const r = app.store.reply(ex);
  if (ex.parsed.kind === 'count_tokens') return r.counted != null ? `counted ${fmtInt(r.counted)} input tokens` : (ex.end ? 'no count' : 'waiting…');
  const kinds = {};
  for (const b of r.blocks) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  const bits = [];
  if (kinds.text) bits.push('text');
  if (kinds.thinking) bits.push('thinking');
  if (kinds.tool_call) bits.push(plural(kinds.tool_call, 'tool call'));
  let s = bits.join(' + ') || (ex.end ? 'empty' : 'waiting…');
  if (r.stop_reason) s += ' · ' + r.stop_reason;
  if (!ex.end) s += ' · streaming…';
  if (r.error) s += ' · error';
  return s;
}

function replyBody(app, ex) {
  const { store } = app;
  const r = store.reply(ex);
  const box = el('div', { class: 'reply' });
  if (r.error) box.appendChild(el('div', { class: 'blk kind-error' }, el('span', { class: 'ico', text: ICON.error }), ' ' + r.error));
  if (ex.end?.error) box.appendChild(el('div', { class: 'blk kind-error' }, el('span', { class: 'ico', text: ICON.error }), ' ' + ex.end.error));
  if (ex.parsed.kind === 'count_tokens') {
    box.appendChild(el('div', { class: 'dim', text: r.counted != null ? `Token count: ${fmtInt(r.counted)} input tokens (counting is not a model call and is not priced).` : 'No count returned.' }));
    return box;
  }
  for (const b of r.blocks) box.appendChild(blockView(b, 'assistant', {}));
  if (!ex.end) box.appendChild(el('span', { class: 'cursor big' }));
  else if (!r.blocks.length && !r.error && !ex.end.error) {
    const raw = ex.chunks.map((c) => c.data).join('');
    box.appendChild(el('div', { class: 'dim', text: raw ? 'Reply not recognised; see Raw.' : '(no reply body)' }));
  }
  const u = store.usage(ex);
  const foot = [`stop reason: ${r.stop_reason || '–'}`];
  if (u) {
    foot.push(`input ${fmtInt(u.input)} · output ${fmtInt(u.output)} · cache read ${fmtInt(u.cache_read)} · cache write ${fmtInt(u.cache_write)}`);
    const c = costOf(app.prices, store.model(ex), u);
    foot.push(c == null ? 'API-equivalent estimate: price unknown' : `API-equivalent estimate: ${fmtUsd(c)}`);
  }
  box.appendChild(el('div', { class: 'reply-foot', text: foot.join('  ·  ') }));
  return box;
}

function callsSummary(app, ex) {
  const calls = app.store.reply(ex).blocks.filter((b) => b.kind === 'tool_call');
  if (!calls.length) return 'none';
  const done = calls.filter((c) => app.store.resultFor(ex, c.id)).length;
  return `${calls.map((c) => c.name).join(', ')} · ${done}/${calls.length} results`;
}

function callsBody(app, ex) {
  const { store } = app;
  const calls = store.reply(ex).blocks.filter((b) => b.kind === 'tool_call');
  const box = el('div', { class: 'pairs' });
  if (!calls.length) {
    box.appendChild(el('div', { class: 'dim', text: ex.end ? 'This reply requested no tool calls.' : 'No tool calls yet.' }));
    return box;
  }
  const ctx = {
    resultFor: (id) => store.resultFor(ex, id),
    callFor: (id) => store.callFor(ex, id),
    link: (e2) => app.link(e2),
    subagentFor: (id) => subagentLink(app, ex.thread, id),
  };
  for (const c of calls) {
    box.appendChild(callPair(c, ctx));
    const res = store.resultFor(ex, c.id);
    if (res && ex.tEnd != null) box.lastChild.querySelector('.pair-head')?.append(el('span', { class: 'dim', title: 'Tool round-trip: includes tool run time, permission prompts and agent overhead', text: ` · round-trip ${fmtMs(res.ex.t0 - ex.tEnd)}` }));
  }
  return box;
}

// For an Agent/Task call: link to the subagent thread and its latest reply.
function subagentLink(app, thread, callId) {
  const sub = thread?.subagents.get(callId);
  if (!sub) return null;
  const last = sub.requests[sub.requests.length - 1];
  const r = app.store.reply(last);
  const text = r.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n');
  const finished = last.end && r.stop_reason && r.stop_reason !== 'tool_use';
  return el('div', { class: 'subagent-box' },
    el('div', {}, el('span', { class: 'badge sub', text: 'subagent' }), ' ',
      app.link(last, `${app.labels.get(sub).label} (${plural(sub.requests.length, 'request')})`),
      app.store.isLive(sub) ? el('span', { class: 'live', text: ' ● running' }) : null,
      sub.linkedBy === 'timing' ? el('span', { class: 'badge warn', title: 'Linked because it was the only pending subagent call; the prompt text did not match.', text: 'linked by timing' }) : null),
    text ? el('div', { class: 'sub-label', text: finished ? 'subagent final reply:' : 'subagent latest text:' }) : null,
    text ? longText(text, { render: (t) => richText(t, { markdown: true }) }) : null);
}

// Pair calls and results within one request's own message list.
function localPairs(messages) {
  const calls = new Map(), results = new Map();
  messages.forEach((m, i) => m.blocks.forEach((b) => {
    if (b.kind === 'tool_call') calls.set(b.id, { call: b, ex: null, msgIndex: i });
    else if (b.kind === 'tool_result' && !results.has(b.call_id)) results.set(b.call_id, { block: b, ex: null });
  }));
  return { calls, results };
}

// Role as shown to the reader: system-role messages are harness-injected.
function roleLabel(role) {
  return role === 'system' ? HARNESS_ROLE_LABEL : role;
}

// A history message collapsed to one line.
function messageLine(m, i, ctx, local) {
  const summary = m.blocks.map((b) => {
    if (b.kind === 'tool_call') return `→ ${b.name}`;
    if (b.kind === 'tool_result') return `← ${local.calls.get(b.call_id)?.call.name || 'result'}${b.is_error ? ' ✗' : ''}`;
    if (b.kind === 'thinking') return '∴';
    if (b.kind === 'text') return '"' + oneLine((m.role === 'system' ? b.text : stripHarness(b.text)) || '[harness text]', 60) + '"';
    return b.kind;
  }).join(' ');
  const icon = m.role === 'assistant' ? ICON.assistant : m.role === 'system' ? ICON.harness : ICON.user;
  return disclosure(
    el('span', { class: `msg-line role-${m.role}` }, el('span', { class: 'r-num', text: String(i) }), el('span', { class: 'ico', text: icon }), el('b', { text: roleLabel(m.role) }), ' ', el('span', { class: 'dim', text: oneLine(summary, 140) })),
    () => {
      const box = el('div');
      for (const b of m.blocks) {
        if (b.kind === 'tool_result' && local.calls.has(b.call_id)) {
          // Already shown next to its call; keep a compact pointer so nothing is doubled.
          box.appendChild(el('div', { class: 'blk kind-result compact' }, el('span', { class: 'ico', text: ICON.result }),
            ` ↩ result of ${local.calls.get(b.call_id).call.name} — shown next to its call (message ${findCallMsg(local, b.call_id)})`,
            disclosure(el('span', { class: 'linkish', text: 'show here' }), () => resultView(b, ctx, { label: false }))));
        } else box.appendChild(blockView(b, m.role, ctx));
      }
      return box;
    }, { cls: 'msg' });
}

function findCallMsg(local, id) {
  return local.calls.get(id)?.msgIndex ?? 'above';
}

// --------------------------------------------------------------------- raw

function rawSection(app, ex, open) {
  return section({
    key: open ? 'raw-open' : 'raw', title: ' Raw', kind: 'raw', state: app.state.sections, open,
    summary: 'request · response · headers',
    render: () => {
      const box = el('div', { class: 'raw' });
      const req = ex.req;
      const bodyStr = 'body' in req ? JSON.stringify(req.body, null, 2) : req.body_text ?? req.body_b64 ?? '';
      box.appendChild(el('div', { class: 'sub-label' }, 'request body ', copyButton(bodyStr)));
      if ('body' in req) box.appendChild(jsonTree(req.body));
      else if (req.body_text != null) box.appendChild(textOrJson(req.body_text));
      else if (req.body_b64 != null) box.appendChild(el('div', { class: 'dim', text: `binary body, ${req.body_b64.length} base64 characters` }));
      else box.appendChild(el('div', { class: 'dim', text: '(no body)' }));
      if (ex.parsed) {
        box.appendChild(el('div', { class: 'sub-label' }, 'other request fields (not system/tools/messages) ', copyButton(JSON.stringify(ex.parsed.params, null, 2))));
        box.appendChild(jsonTree(ex.parsed.params));
      }
      box.appendChild(el('div', { class: 'sub-label' }, 'request headers (credentials redacted by the proxy) ', copyButton(() => headerText(req.headers))));
      box.appendChild(headerTable(req.headers));
      if (ex.end) {
        box.appendChild(el('div', { class: 'sub-label' }, `response ${ex.end.status ?? ''} headers `, copyButton(() => headerText(ex.end.headers))));
        box.appendChild(headerTable(ex.end.headers));
      }
      const stream = ex.chunks.map((c) => c.data).join('');
      box.appendChild(el('div', { class: 'sub-label' }, `response body (${plural(ex.chunks.length, 'chunk')}) `, copyButton(() => ex.chunks.map((c) => c.data).join(''))));
      box.appendChild(stream ? textOrJson(stream, { render: plainText }) : el('div', { class: 'dim', text: ex.end ? '(empty)' : '(nothing yet)' }));
      return box;
    },
  });
}

function headerRows(h) {
  return Array.isArray(h) ? h : Object.entries(h || {});
}

function headerText(h) {
  return headerRows(h).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function headerTable(h) {
  const rows = headerRows(h);
  const tbl = el('table', { class: 'hdrs' });
  for (const [k, v] of rows) tbl.appendChild(el('tr', {}, el('td', { text: k }), el('td', { text: String(v) })));
  if (!rows.length) tbl.appendChild(el('tr', {}, el('td', { class: 'dim', text: '(none)' })));
  return tbl;
}

