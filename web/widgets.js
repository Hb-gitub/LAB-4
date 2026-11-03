// In-house widgets (SPEC D4, D6): collapsible sections, long-text previews,
// JSON tree, word diff, and the block renderer with fixed kind colours/icons.
// Everything is inserted with textContent; nothing captured is parsed as HTML.

import { el, copyButton, stringify, fmtBytes, oneLine } from './util.js';
import { HARNESS_RE } from './model.js';

export const PREVIEW_LINES = 20;
export const PREVIEW_CHARS = 2000;

// Fixed icon per block kind, used the same way everywhere.
export const ICON = {
  system: '§', tooldef: '⚒', user: '›', assistant: '◆', thinking: '∴',
  call: '→', result: '←', error: '✗', harness: '⚑', image: '▣', other: '◇',
};

// ---------------------------------------------------------------- section

// A collapsible section whose body is rendered lazily the first time it opens.
// `state` is a shared object remembering open/closed per section key.
export function section({ key, title, kind, summary, badges = [], open, render, state, extra }) {
  const isOpen = state && key in state ? state[key] : open;
  const body = el('div', { class: 'sec-body' });
  const head = el('div', { class: 'sec-head', role: 'button', tabindex: '0' },
    el('span', { class: 'chev' }),
    el('span', { class: `sec-title kind-${kind || 'none'}` }, title),
    el('span', { class: 'sec-summary', text: summary || '' }),
    badges,
    extra || null,
  );
  const root = el('section', { class: 'sec' + (isOpen ? ' open' : ''), dataset: { key } }, head, body);
  let rendered = false;
  const ensure = () => {
    if (rendered) return;
    rendered = true;
    try { body.appendChild(render()); } catch (e) { body.appendChild(el('div', { class: 'warn', text: 'render failed: ' + e.message })); console.error(e); }
  };
  if (isOpen) ensure();
  const toggle = () => {
    const now = !root.classList.contains('open');
    root.classList.toggle('open', now);
    if (state) state[key] = now;
    if (now) ensure();
  };
  head.addEventListener('click', (e) => { if (!e.target.closest('button')) toggle(); });
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  root.rerender = () => {
    rendered = false;
    body.textContent = '';
    if (root.classList.contains('open')) ensure();
  };
  root.setSummary = (s) => { head.querySelector('.sec-summary').textContent = s; };
  return root;
}

export function badge(text, cls = '') {
  return el('span', { class: 'badge ' + cls, text });
}

// A small inline disclosure: label line, body rendered lazily on first open.
export function disclosure(label, render, { open = false, cls = '' } = {}) {
  const body = el('div', { class: 'disc-body' });
  const head = el('div', { class: 'disc-head', role: 'button', tabindex: '0' }, el('span', { class: 'chev' }), label);
  const root = el('div', { class: 'disc ' + cls + (open ? ' open' : '') }, head, body);
  let rendered = false;
  const ensure = () => { if (!rendered) { rendered = true; body.appendChild(render()); } };
  if (open) ensure();
  const toggle = (e) => {
    if (e.target.closest('button')) return;
    root.classList.toggle('open');
    if (root.classList.contains('open')) ensure();
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(e); });
  return root;
}

// -------------------------------------------------------------- long text

function countLines(s) {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

// Long text is cut to a preview; the full text is rendered only when asked.
export function longText(text, { render = plainText, cls = '' } = {}) {
  text = String(text ?? '');
  const lines = countLines(text);
  if (lines <= PREVIEW_LINES && text.length <= PREVIEW_CHARS) return el('div', { class: 'lt ' + cls }, render(text));
  let cut = 0;
  for (let i = 0; i < PREVIEW_LINES; i++) {
    const j = text.indexOf('\n', cut);
    if (j < 0) { cut = text.length; break; }
    cut = j + 1;
  }
  cut = Math.min(cut || text.length, PREVIEW_CHARS);
  const box = el('div', { class: 'lt ' + cls });
  const showAll = () => {
    box.textContent = '';
    box.append(render(text), el('button', { class: 'more', type: 'button', text: 'show less', onclick: showLess }));
  };
  const showLess = () => {
    box.textContent = '';
    box.append(render(text.slice(0, cut)), el('div', { class: 'fade' }),
      el('button', { class: 'more', type: 'button', text: `show all (${lines.toLocaleString()} lines, ${fmtBytes(text.length)})`, onclick: showAll }));
  };
  showLess();
  return box;
}

export function plainText(text) {
  return el('div', { class: 'pre', text });
}

// Text with harness tags highlighted and (optionally) light markdown.
export function richText(text, { markdown = false } = {}) {
  const root = el('div', { class: 'pre rich' });
  let last = 0;
  HARNESS_RE.lastIndex = 0;
  for (let m; (m = HARNESS_RE.exec(text));) {
    if (m.index > last) root.appendChild(markdown ? md(text.slice(last, m.index)) : document.createTextNode(text.slice(last, m.index)));
    root.appendChild(harnessTag(m[1], m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) root.appendChild(markdown ? md(text.slice(last)) : document.createTextNode(text.slice(last)));
  return root;
}

function harnessTag(name, whole) {
  return el('span', { class: 'harness', title: 'Injected by the agent harness, not typed by the user' },
    el('span', { class: 'harness-tag', text: `${ICON.harness} ${name}` }),
    document.createTextNode(whole));
}

// Light markdown: fenced code, headings, inline code. Everything stays text.
function md(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m);
  for (const part of parts) {
    if (!part) continue;
    const fence = /^```([^\n]*)\n([\s\S]*?)```[ \t]*$/.exec(part);
    if (fence) {
      frag.appendChild(el('div', { class: 'md-code' }, fence[1] ? el('span', { class: 'md-lang', text: fence[1] }) : null, el('code', { text: fence[2] })));
      continue;
    }
    const lines = part.split('\n');
    lines.forEach((line, i) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const target = h ? el('span', { class: 'md-h md-h' + h[1].length }) : frag;
      inline(target, h ? h[2] : line);
      if (h) frag.appendChild(target);
      if (i < lines.length - 1) frag.appendChild(document.createTextNode('\n'));
    });
  }
  return frag;
}

function inline(target, line) {
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let m; (m = re.exec(line));) {
    if (m.index > last) target.appendChild(document.createTextNode(line.slice(last, m.index)));
    target.appendChild(m[1] != null ? el('code', { class: 'md-ic', text: m[1] }) : el('strong', { text: m[2] }));
    last = m.index + m[0].length;
  }
  if (last < line.length) target.appendChild(document.createTextNode(line.slice(last)));
}

// --------------------------------------------------------------- JSON tree

function looksJson(s) {
  if (s.length < 2) return false;
  const t = s.trim();
  if (!((t[0] === '{' && t.endsWith('}')) || (t[0] === '[' && t.endsWith(']')))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

// SPEC D6: the top two levels start open; anything deeper starts collapsed.
export const JSON_OPEN_DEPTH = 2;

export function jsonTree(value, { openDepth = JSON_OPEN_DEPTH } = {}) {
  return el('div', { class: 'jt' }, jnode(value, null, 0, openDepth));
}

function jnode(v, key, depth, openDepth) {
  const keyEl = key == null ? null : el('span', { class: 'j-key', text: typeof key === 'number' ? `${key}: ` : `${JSON.stringify(key)}: ` });
  if (v === null || typeof v !== 'object') {
    return el('div', { class: 'j-row' }, keyEl, jprim(v), copyButton(() => (typeof v === 'string' ? v : JSON.stringify(v))));
  }
  const isArr = Array.isArray(v);
  const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
  const preview = isArr ? `[${entries.length}]` : `{${entries.length} key${entries.length === 1 ? '' : 's'}}`;
  if (!entries.length) return el('div', { class: 'j-row' }, keyEl, el('span', { class: 'j-punct', text: isArr ? '[]' : '{}' }));
  const kids = el('div', { class: 'j-kids' });
  const node = el('div', { class: 'j-node' });
  let rendered = false;
  const render = () => {
    if (rendered) return;
    rendered = true;
    for (const [k, x] of entries) kids.appendChild(jnode(x, k, depth + 1, openDepth));
  };
  const head = el('div', { class: 'j-row j-toggle' },
    el('span', { class: 'chev' }), keyEl, el('span', { class: 'j-punct', text: preview }),
    copyButton(() => JSON.stringify(v, null, 2)));
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    node.classList.toggle('open');
    if (node.classList.contains('open')) render();
  });
  node.append(head, kids);
  if (depth < openDepth) { node.classList.add('open'); render(); }
  return node;
}

function jprim(v) {
  if (typeof v === 'string') {
    const wrap = el('span', { class: 'j-str-wrap' });
    const asText = () => {
      wrap.textContent = '';
      if (v.length > 120 || v.includes('\n')) wrap.appendChild(longText(v, { cls: 'j-str', render: (t) => el('div', { class: 'pre j-str', text: t }) }));
      else wrap.appendChild(el('span', { class: 'j-str', text: JSON.stringify(v) }));
      if (looksJson(v)) wrap.appendChild(el('button', { class: 'linkish', type: 'button', text: 'view as JSON', onclick: asJson }));
    };
    const asJson = () => {
      wrap.textContent = '';
      wrap.append(jsonTree(JSON.parse(v.trim())), el('button', { class: 'linkish', type: 'button', text: 'view as text', onclick: asText }));
    };
    asText();
    return wrap;
  }
  const cls = typeof v === 'number' ? 'j-num' : typeof v === 'boolean' ? 'j-bool' : 'j-null';
  return el('span', { class: cls, text: v === undefined ? 'undefined' : JSON.stringify(v) });
}

// Text that may be JSON: a tree if it parses, otherwise a long-text block.
export function textOrJson(text, opts = {}) {
  if (looksJson(text)) {
    const box = el('div');
    const asTree = () => { box.textContent = ''; box.append(el('button', { class: 'linkish', type: 'button', text: 'view as text', onclick: asText }), jsonTree(JSON.parse(text.trim()))); };
    const asText = () => { box.textContent = ''; box.append(el('button', { class: 'linkish', type: 'button', text: 'view as JSON', onclick: asTree }), longText(text, opts)); };
    asText();
    return box;
  }
  return longText(text, opts);
}

// --------------------------------------------------------------- word diff

export function wordDiff(a, b) {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const ops = []; // [type, text]
  if (s) ops.push(['=', A.slice(0, s).join('')]);
  const ma = A.slice(s, ea), mb = B.slice(s, eb);
  if (ma.length * mb.length > 4e6) {
    if (ma.length) ops.push(['-', ma.join('')]);
    if (mb.length) ops.push(['+', mb.join('')]);
  } else {
    // LCS table on the changed middle only.
    const n = ma.length, m = mb.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = ma[i] === mb[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
    let i = 0, j = 0;
    const push = (t, x) => { if (ops.length && ops[ops.length - 1][0] === t) ops[ops.length - 1][1] += x; else ops.push([t, x]); };
    while (i < n && j < m) {
      if (ma[i] === mb[j]) { push('=', ma[i]); i++; j++; }
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { push('-', ma[i++]); }
      else push('+', mb[j++]);
    }
    while (i < n) push('-', ma[i++]);
    while (j < m) push('+', mb[j++]);
  }
  if (ea < A.length) ops.push(['=', A.slice(ea).join('')]);
  const root = el('div', { class: 'pre diff' });
  for (const [t, x] of ops) {
    if (t === '=') {
      if (x.length > 600) {
        root.append(x.slice(0, 200), el('span', { class: 'diff-skip', text: ` … ${x.match(/\S+/g)?.length ?? 0} words unchanged … ` }), x.slice(-200));
      } else root.append(x);
    } else root.appendChild(el(t === '+' ? 'ins' : 'del', { text: x }));
  }
  return root;
}

// ------------------------------------------------------------- block view

// Renders one neutral content block. `ctx` supplies pairing lookups:
//   ctx.resultFor(callId) -> {block, ex}|null, ctx.callFor(callId) -> {call, ex}|null,
//   ctx.link(ex) -> element linking to a request, ctx.pairCalls (bool)
export const HARNESS_ROLE_LABEL = 'harness / system-role';

export function blockView(b, role, ctx = {}) {
  // System-role messages inside messages[] are injected by the agent harness,
  // never typed by the user: their own block kind, styled like harness tags.
  if (role === 'system' && b.kind !== 'tool_call' && b.kind !== 'tool_result') return harnessRoleBlock(b);
  switch (b.kind) {
    case 'text': {
      const kind = role === 'assistant' ? 'assistant' : 'user';
      return el('div', { class: `blk kind-${kind}` },
        el('div', { class: 'blk-label' }, el('span', { class: 'ico', text: ICON[kind] }), role === 'assistant' ? 'assistant text' : `${role} text`, copyButton(b.text)),
        longText(b.text, { render: (t) => richText(t, { markdown: role === 'assistant' }) }));
    }
    case 'thinking':
      return el('div', { class: 'blk kind-thinking' },
        disclosure(el('span', { class: 'blk-label' }, el('span', { class: 'ico', text: ICON.thinking }), 'thinking', el('span', { class: 'dim', text: ' ' + oneLine(b.text, 80) })),
          () => longText(b.text)));
    case 'tool_call':
      if (ctx.pairCalls) return callPair(b, ctx);
      return callView(b);
    case 'tool_result':
      return resultView(b, ctx);
    case 'image':
      return el('div', { class: 'blk kind-other' }, el('span', { class: 'ico', text: ICON.image }), ` image · ${b.media_type} · ${fmtBytes(Math.round(b.size))}`);
    default:
      return el('div', { class: 'blk kind-other' },
        el('div', { class: 'blk-label' }, el('span', { class: 'ico', text: ICON.other }), `${b.type} block`),
        jsonTree(b.raw));
  }
}

function harnessRoleBlock(b) {
  const label = el('div', { class: 'blk-label' }, el('span', { class: 'ico', text: ICON.harness }), HARNESS_ROLE_LABEL,
    b.kind !== 'text' ? el('span', { class: 'dim', text: ` · ${b.type || b.kind} block` }) : null,
    b.kind === 'text' ? copyButton(b.text) : null);
  const body = b.kind === 'text' ? longText(b.text, { render: (t) => richText(t) }) : jsonTree(b.raw);
  return el('div', { class: 'blk kind-harness', title: 'System-role message injected by the agent harness, not typed by the user' }, label, body);
}

export function callView(b) {
  return el('div', { class: 'blk kind-call' },
    el('div', { class: 'blk-label' }, el('span', { class: 'ico', text: ICON.call }), el('b', { text: b.name }), el('span', { class: 'dim', text: ` ${b.id || ''}` }),
      copyButton(() => (b.partial != null ? b.partial : JSON.stringify(b.input, null, 2)))),
    b.partial != null
      ? el('div', { class: 'pre streaming-json', text: b.partial }, el('span', { class: 'cursor' }))
      : (b.input && typeof b.input === 'object' ? jsonTree(b.input) : plainText(stringify(b.input))));
}

export function resultView(b, ctx = {}, { label = true } = {}) {
  const c = ctx.callFor ? ctx.callFor(b.call_id) : null;
  const kind = b.is_error ? 'error' : 'result';
  return el('div', { class: `blk kind-${kind}` },
    label ? el('div', { class: 'blk-label' }, el('span', { class: 'ico', text: ICON[kind] }),
      `↩ ${c ? c.call.name : 'tool'}`, c?.ex && ctx.link ? [' ', ctx.link(c.ex)] : null,
      b.is_error ? el('span', { class: 'badge err', text: 'error' }) : null,
      el('span', { class: 'dim', text: ` ${b.call_id || ''}` })) : null,
    resultContent(b));
}

export function resultContent(b) {
  const box = el('div', { class: 'result-content' });
  if (!b.content.length) box.appendChild(el('div', { class: 'dim', text: '(empty result)' }));
  for (const x of b.content) {
    if (x.kind === 'text') box.appendChild(textOrJson(x.text, { render: (t) => richText(t) }));
    else box.appendChild(blockView(x, 'user'));
  }
  return box;
}

// A call and its result side by side (SPEC R3).
export function callPair(call, ctx) {
  const res = ctx.resultFor ? ctx.resultFor(call.id) : null;
  let right;
  if (res) {
    right = el('div', { class: 'pair-right' },
      el('div', { class: 'pair-head' }, res.block.is_error ? el('span', { class: 'badge err', text: 'error' }) : el('span', { class: 'badge ok', text: 'result' }),
        res.ex && ctx.link ? [' in ', ctx.link(res.ex)] : ' (in this request)'),
      resultView(res.block, ctx, { label: false }));
  } else {
    right = el('div', { class: 'pair-right pending' }, el('span', { class: 'spinner' }), ' pending…');
  }
  const sub = ctx.subagentFor ? ctx.subagentFor(call.id) : null;
  if (sub) right.prepend(sub);
  return el('div', { class: 'pair' }, el('div', { class: 'pair-left' }, callView(call)), right);
}
