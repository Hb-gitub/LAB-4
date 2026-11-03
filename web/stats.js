// Summary strip and Stats tab (SPEC D7, D8). Every bar and row links back to
// the drill-down: clicking filters the thread tree and opens the first request.

import { el, svg, fmtInt, fmtTokens, fmtMs, fmtUsd, plural } from './util.js';
import { costOf, blockText } from './model.js';

export function totals(app, exs) {
  const { store } = app;
  const t = { requests: exs.length, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, priced: 0, excluded: 0, start: Infinity, end: -Infinity };
  for (const ex of exs) {
    t.start = Math.min(t.start, ex.t0);
    t.end = Math.max(t.end, ex.tEnd ?? Date.now());
    const u = store.usage(ex);
    if (!u) continue;
    t.withUsage = (t.withUsage || 0) + 1;
    t.input += u.input; t.output += u.output; t.cache_read += u.cache_read; t.cache_write += u.cache_write;
    const c = costOf(app.prices, store.model(ex), u);
    if (c == null) t.excluded++; else { t.cost += c; t.priced++; }
  }
  const denom = t.input + t.cache_read + t.cache_write;
  t.cacheHit = denom ? t.cache_read / denom : null;
  t.wall = exs.length ? t.end - t.start : null;
  return t;
}

export function costLabel(t) {
  if (!t.withUsage) return '–';
  const est = t.priced || !t.excluded ? '~' + fmtUsd(t.cost) : 'price unknown';
  return t.excluded && t.priced ? `${est} (excludes ${plural(t.excluded, 'request')})` : est;
}

export function renderStrip(app, exs) {
  const t = totals(app, exs);
  const item = (label, value, title) => el('span', { class: 'strip-item', title }, el('span', { class: 'strip-label', text: label }), el('span', { class: 'strip-value', text: value }));
  return [
    item('requests', fmtInt(t.requests)),
    item('input / output', `${fmtTokens(t.input)} / ${fmtTokens(t.output)}`, `uncached input ${fmtInt(t.input)} · output ${fmtInt(t.output)} · cache read ${fmtInt(t.cache_read)} · cache write ${fmtInt(t.cache_write)}`),
    item('cache hit', t.cacheHit == null ? '–' : (t.cacheHit * 100).toFixed(1) + '%', 'cache_read / (input + cache_read + cache_write)'),
    item('wall time', fmtMs(t.wall), 'first request start to last response end'),
    item('API-equivalent estimate', costLabel(t), 'What this traffic would cost at API list prices (prices.json). Not a charge on a subscription login.'),
  ];
}

// ----------------------------------------------------------------- stats tab

export function renderStats(app, exs) {
  const root = el('div', { class: 'stats' });
  const modelEx = exs.filter((ex) => ex.adapter);
  root.appendChild(el('h3', { text: 'Over time' }));
  root.appendChild(overTime(app, modelEx));
  root.appendChild(el('h3', { text: 'Per thread' }));
  root.appendChild(perThread(app, modelEx));
  root.appendChild(el('h3', { text: 'Tool breakdown' }));
  root.appendChild(toolBreakdown(app, modelEx));
  root.appendChild(el('h3', { text: 'Per model' }));
  root.appendChild(perModel(app, modelEx));
  root.appendChild(el('p', { class: 'dim', text: 'Costs are API-equivalent estimates at list prices from prices.json. Latency = end − request time. Tool round-trip = start of the request carrying the result − end of the reply that made the call (includes tool run time, permission prompts and agent overhead).' }));
  return root;
}

const KINDS = [
  ['input', 'uncached input', 'var(--k-user)'],
  ['cache_read', 'cache read', 'var(--k-system)'],
  ['cache_write', 'cache write', 'var(--k-tooldef)'],
  ['output', 'output', 'var(--k-assistant)'],
];

function overTime(app, exs) {
  const { store } = app;
  if (!exs.length) return el('div', { class: 'dim', text: 'No model requests.' });
  const list = [...exs].sort((a, b) => a.seq - b.seq);
  const W = Math.max(600, list.length * 8), H1 = 150, H2 = 80, gap = 26, strip = 5;
  const bw = W / list.length;
  const tok = list.map((ex) => store.usage(ex) || { input: 0, output: 0, cache_read: 0, cache_write: 0 });
  const maxTok = Math.max(1, ...tok.map((u) => u.input + u.output + u.cache_read + u.cache_write));
  const lat = list.map((ex) => store.latency(ex) ?? (Date.now() - ex.t0));
  const maxLat = Math.max(1, ...lat);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H1 + strip + gap + H2 + 14}`, class: 'chart', preserveAspectRatio: 'none', width: '100%', height: H1 + strip + gap + H2 + 14 });
  s.appendChild(svg('text', { x: 2, y: 11, class: 'axis', text: `tokens (max ${fmtInt(maxTok)})` }));
  s.appendChild(svg('text', { x: 2, y: H1 + strip + gap - 4, class: 'axis', text: `latency (max ${fmtMs(maxLat)})` }));
  list.forEach((ex, i) => {
    const x = i * bw, w = Math.max(1, bw - 1);
    const g = svg('g', { class: 'bar', onclick: () => app.filterTo([ex], `request #${ex.seq}`) });
    let y = H1;
    for (const [k, , color] of KINDS) {
      const h = (tok[i][k] / maxTok) * (H1 - 16);
      if (h <= 0) continue;
      y -= h;
      g.appendChild(svg('rect', { x, y, width: w, height: h, fill: color }));
    }
    g.appendChild(svg('rect', { x, y: H1 + 1, width: w, height: strip, fill: app.threadColor(ex.thread) }));
    const lh = (lat[i] / maxLat) * (H2 - 4);
    g.appendChild(svg('rect', { x, y: H1 + strip + gap + H2 - lh, width: w, height: Math.max(1, lh), fill: app.threadColor(ex.thread), opacity: ex.end ? 1 : 0.5 }));
    g.appendChild(svg('rect', { x, y: 0, width: Math.max(w, 1), height: H1 + strip + gap + H2, fill: 'transparent' }));
    const u = tok[i];
    g.appendChild(svg('title', { text: `#${ex.seq} · ${app.labels.get(ex.thread).label}\ninput ${fmtInt(u.input)} · cache read ${fmtInt(u.cache_read)} · cache write ${fmtInt(u.cache_write)} · output ${fmtInt(u.output)}\nlatency ${fmtMs(store.latency(ex))}` }));
    s.appendChild(g);
  });
  const legend = el('div', { class: 'legend' },
    KINDS.map(([, label, color]) => el('span', {}, el('span', { class: 'swatch', style: `background:${color}` }), label)),
    el('span', { class: 'dim', text: '· strip and latency bars: thread colour' }));
  return el('div', { class: 'chart-wrap' }, el('div', { class: 'chart-scroll' }, s), legend);
}

function table(headers, rows) {
  const tbl = el('table', { class: 'stats-table' });
  tbl.appendChild(el('tr', {}, headers.map((h) => el('th', { text: h }))));
  for (const r of rows) {
    const tr = el('tr', { class: 'clickable', onclick: r.onclick, title: 'Filter the thread tree to these requests' }, r.cells.map((c, i) => el('td', { class: i ? 'num' : '', text: c })));
    tbl.appendChild(tr);
  }
  if (!rows.length) tbl.appendChild(el('tr', {}, el('td', { class: 'dim', text: '(none)' })));
  return tbl;
}

function perThread(app, exs) {
  const by = new Map();
  for (const ex of exs) {
    if (!by.has(ex.thread)) by.set(ex.thread, []);
    by.get(ex.thread).push(ex);
  }
  const rows = [...by.entries()].sort((a, b) => b[0].lastT - a[0].lastT).map(([t, list]) => {
    const s = totals(app, list);
    const time = list.reduce((n, ex) => n + (app.store.latency(ex) || 0), 0);
    const label = app.labels.get(t).label;
    return {
      cells: [label, fmtInt(list.length), fmtTokens(s.input), fmtTokens(s.cache_read), fmtTokens(s.cache_write), fmtTokens(s.output), fmtMs(time), costLabel(s)],
      onclick: () => app.filterTo(list, label),
    };
  });
  return table(['thread', 'requests', 'input', 'cache read', 'cache write', 'output', 'time (sum)', 'API-equiv. estimate'], rows);
}

function toolBreakdown(app, exs) {
  const set = new Set(exs);
  const tools = new Map();
  for (const t of app.store.threads) {
    for (const [id, { call, ex }] of t.calls) {
      if (!set.has(ex)) continue;
      let s = tools.get(call.name);
      if (!s) tools.set(call.name, (s = { calls: 0, errors: 0, rts: [], sizes: [], exs: new Set() }));
      s.calls++;
      s.exs.add(ex);
      const res = t.results.get(id);
      if (res) {
        if (res.block.is_error) s.errors++;
        if (ex.tEnd != null) s.rts.push(res.ex.t0 - ex.tEnd);
        s.sizes.push(res.block.content.map(blockText).join('').length);
        s.exs.add(res.ex);
      }
    }
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const rows = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls).map(([name, s]) => ({
    cells: [name, fmtInt(s.calls), fmtInt(s.errors), fmtMs(avg(s.rts)), fmtMs(s.rts.length ? Math.max(...s.rts) : null),
      s.sizes.length ? fmtInt(avg(s.sizes)) + ' chars' : '–'],
    onclick: () => app.filterTo([...s.exs], `tool ${name}`),
  }));
  return table(['tool', 'calls', 'errors', 'avg round-trip*', 'max round-trip*', 'avg result size'], rows);
}

function perModel(app, exs) {
  const by = new Map();
  for (const ex of exs) {
    const m = app.store.model(ex) || '?';
    if (!by.has(m)) by.set(m, []);
    by.get(m).push(ex);
  }
  const rows = [...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([m, list]) => {
    const s = totals(app, list);
    return {
      cells: [m, fmtInt(list.length), fmtTokens(s.input + s.cache_read + s.cache_write), fmtTokens(s.output), costLabel(s)],
      onclick: () => app.filterTo(list, `model ${m}`),
    };
  });
  return table(['model', 'requests', 'input (all)', 'output', 'API-equiv. estimate'], rows);
}
