// App shell: connects to the dashboard server, feeds the store, and schedules
// rendering of the tree, detail/stats pane and summary strip.

import { Store } from './model.js';
import { el, fmtBytes, fmtDate, plural } from './util.js';
import { renderTree, renderDetail, threadLabels } from './views.js';
import { renderStrip, renderStats } from './stats.js';

const $ = (id) => document.getElementById(id);
const PALETTE = ['#4f8ff7', '#e8833a', '#3fb27f', '#c561d6', '#d9b23c', '#e0566a', '#38b6c4', '#8a7cf0', '#9aa64a', '#d27fa8'];

const app = {
  store: new Store(),
  prices: {},
  labels: new Map(),
  es: null,
  caughtUp: false,
  state: {
    logName: null, logs: [], openedNewest: null,
    follow: true, selectedId: null, newCount: 0,
    search: '', filter: null, tab: 'detail',
    threadOpen: new Map(), sections: {}, renames: {},
  },
  detailEl: null, detailFor: null, detailEnded: false,
  dirty: { tree: false, pane: false, strip: false },
  visibleCache: { key: null, set: null },
  labelsVersion: -1,

  // --- helpers used by the views
  threadColor(t) {
    return t ? PALETTE[(t.num - 1) % PALETTE.length] : '#888';
  },
  link(ex, text) {
    return el('button', {
      class: 'link', type: 'button', text: text || '#' + ex.seq, title: 'Open request #' + ex.seq,
      onclick: (e) => { e.stopPropagation(); app.select(ex.id, { manual: true, reveal: true }); },
    });
  },
  visibleSet() {
    const { search, filter } = this.state;
    const key = `${this.store.version}|${search}|${filter ? filter.label : ''}`;
    if (this.visibleCache.key === key) return this.visibleCache.set;
    const q = search.trim().toLowerCase();
    const set = new Set();
    for (const ex of this.store.list) {
      if (filter && !filter.set.has(ex)) continue;
      if (q && !this.store.searchText(ex).includes(q)) continue;
      set.add(ex);
    }
    this.visibleCache = { key, set };
    return set;
  },
  rename(t, info) {
    const name = prompt(`Rename thread (empty = automatic label "${info.guessed}")`, info.label);
    if (name == null) return;
    if (name.trim()) this.state.renames[t.id] = name.trim(); else delete this.state.renames[t.id];
    try { localStorage.setItem('dash.renames.' + this.state.logName, JSON.stringify(this.state.renames)); } catch { /* private mode */ }
    this.labelsVersion = -1;
    this.invalidate(true);
    if (this.detailEl) this.detailFor = null; // header shows the label
  },
  renderTree() {
    this.dirty.tree = true;
    this.schedule();
  },

  // --- selection & follow-live (SPEC D6)
  select(id, { manual = false, reveal = false } = {}) {
    const s = this.state;
    if (manual) {
      const newest = this.newestVisible();
      s.follow = newest ? newest.id === id && s.follow : false;
      if (!s.follow) s.newCount = s.newCount || 0;
    }
    s.selectedId = id;
    if (s.tab !== 'detail') this.setTab('detail');
    const ex = this.store.exchanges.get(id);
    if (reveal && ex?.thread) s.threadOpen.set(ex.thread.id, true);
    if (reveal && ex && !ex.thread) s.threadOpen.set('__raw', true);
    this.dirty.tree = this.dirty.pane = true;
    this.scrollToSel = true;
    this.schedule();
  },
  resumeLive() {
    this.state.follow = true;
    this.state.newCount = 0;
    const n = this.newestVisible();
    if (n) this.select(n.id);
    this.dirty.tree = true;
    this.schedule();
  },
  newestVisible() {
    const vis = this.visibleSet();
    for (let i = this.store.list.length - 1; i >= 0; i--) if (vis.has(this.store.list[i])) return this.store.list[i];
    return null;
  },
  filterTo(exs, label) {
    const set = new Set(exs);
    this.state.filter = { set, label };
    this.state.follow = false;
    const first = [...set].sort((a, b) => a.seq - b.seq)[0];
    for (const ex of set) if (ex.thread) this.state.threadOpen.set(ex.thread.id, true); else this.state.threadOpen.set('__raw', true);
    if (first) this.select(first.id, { manual: true });
    this.invalidate(true);
  },
  setTab(tab) {
    this.state.tab = tab;
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    this.detailFor = null;
    this.dirty.pane = true;
    this.schedule();
  },

  // --- rendering
  invalidate(all) {
    this.dirty.tree = this.dirty.strip = true;
    if (all) this.dirty.pane = true;
    this.schedule();
  },
  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.render(); });
  },
  render() {
    if (!this.caughtUp) return;
    const s = this.state, store = this.store;
    const structural = store.structural;
    const changed = store.changed;
    store.structural = false;
    store.changed = new Set();
    if (structural || this.labelsVersion === -1) {
      this.labels = threadLabels(store, s.renames);
      this.labelsVersion = store.version;
    }
    if (structural || changed.size) this.dirty.strip = true;
    if (structural) this.dirty.tree = true;

    const now = performance.now();
    if (this.dirty.tree || (changed.size && now - (this.lastTree || 0) > 300)) {
      this.dirty.tree = false;
      this.lastTree = now;
      const box = $('tree');
      const top = box.scrollTop;
      box.replaceChildren(renderTree(this));
      box.scrollTop = top;
      if (this.scrollToSel) {
        this.scrollToSel = false;
        box.querySelector('.r-row.sel')?.scrollIntoView({ block: 'nearest' });
      }
      this.renderChrome();
    }
    if (this.dirty.strip) {
      this.dirty.strip = false;
      $('strip').replaceChildren(...renderStrip(this, [...this.visibleSet()]));
    }

    const pane = $('pane');
    if (s.tab === 'stats') {
      if (this.dirty.pane || structural || (changed.size && now - (this.lastStats || 0) > 1000)) {
        this.dirty.pane = false;
        this.lastStats = now;
        const top = pane.scrollTop;
        pane.replaceChildren(renderStats(this, [...this.visibleSet()]));
        pane.scrollTop = top;
      }
      return;
    }
    const ex = store.exchanges.get(s.selectedId) || null;
    if (this.detailFor !== ex || !this.detailEl) {
      this.dirty.pane = false;
      this.detailFor = ex;
      this.detailEnded = !!ex?.end;
      this.detailEl = renderDetail(this, ex);
      pane.replaceChildren(this.detailEl);
      pane.scrollTop = 0;
    } else if (ex && this.detailEl.update) {
      if (changed.has(ex.id)) {
        const ended = !!ex.end && !this.detailEnded;
        this.detailEnded = !!ex.end;
        this.detailEl.update({ mode: ended ? 'end' : 'chunk' });
      } else if (structural || this.dirty.pane) {
        this.detailEl.update({ mode: 'other' });
      }
      this.dirty.pane = false;
    }
  },
  renderChrome() {
    const s = this.state;
    const pill = $('pill');
    pill.hidden = s.follow;
    pill.textContent = s.newCount ? `↑ ${s.newCount} new · resume live` : '⏸ paused · resume live';
    const fb = $('filterbar');
    fb.hidden = !s.filter;
    if (s.filter) fb.replaceChildren(el('span', { text: `filter: ${s.filter.label} (${plural(s.filter.set.size, 'request')})` }),
      el('button', { type: 'button', class: 'link', text: '✕ clear', onclick: () => { s.filter = null; this.invalidate(true); } }));
  },

  // --- connection (SPEC D1, D3)
  async start() {
    try { this.prices = await (await fetch('/api/prices')).json(); } catch { this.prices = {}; }
    await this.refreshLogs();
    const wanted = new URLSearchParams(location.search).get('log');
    const pick = this.state.logs.find((l) => l.name === wanted) || this.state.logs[0];
    if (pick) this.connect(pick.name);
    else this.waitForLogs();
  },
  async refreshLogs() {
    try { this.state.logs = await (await fetch('/api/logs')).json(); } catch { this.state.logs = []; }
    this.renderRunPicker();
  },
  waitForLogs() {
    this.caughtUp = true;
    $('tree').replaceChildren(el('div', { class: 'empty', text: 'No logs yet. Start proxy.py; its first run log will open here automatically.' }));
    const timer = setInterval(async () => {
      await this.refreshLogs();
      if (this.state.logs.length) { clearInterval(timer); this.connect(this.state.logs[0].name); }
    }, 2000);
  },
  connect(name) {
    if (this.es) this.es.close();
    const s = this.state;
    this.store.reset();
    Object.assign(s, { logName: name, follow: true, selectedId: null, newCount: 0, filter: null, threadOpen: new Map() });
    s.openedNewest = s.logs[0]?.name === name;
    try { s.renames = JSON.parse(localStorage.getItem('dash.renames.' + name) || '{}'); } catch { s.renames = {}; }
    this.detailFor = null;
    this.detailEl = null;
    this.caughtUp = false;
    this.labelsVersion = -1;
    $('banner').hidden = true;
    $('tree').replaceChildren(el('div', { class: 'empty', text: 'Loading log…' }));
    history.replaceState(null, '', '?log=' + encodeURIComponent(name));
    this.renderRunPicker();
    // Export run (D9): always the run open in the picker, served as stored by /download.
    const dl = $('dl-run');
    dl.href = '/download?log=' + encodeURIComponent(name);
    dl.setAttribute('download', name);
    dl.classList.remove('disabled');
    dl.removeAttribute('aria-disabled');

    const es = new EventSource('/events?log=' + encodeURIComponent(name));
    this.es = es;
    es.addEventListener('hello', (e) => {
      const h = JSON.parse(e.data);
      if (!h.resume && this.store.list.length) { this.store.reset(); this.detailFor = null; } // server lost our place: rebuild
      $('conn').textContent = '';
    });
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      const before = this.store.list.length;
      this.store.ingest(ev);
      if (!this.caughtUp) return;
      if (this.store.list.length > before) this.onNewRequest();
      this.schedule();
    };
    es.addEventListener('caughtup', () => {
      if (this.caughtUp) return;
      this.caughtUp = true;
      const n = this.newestVisible();
      if (n) s.selectedId = n.id;
      this.scrollToSel = true;
      this.invalidate(true);
    });
    es.addEventListener('logs', (e) => {
      s.logs = JSON.parse(e.data);
      this.renderRunPicker();
      const newest = s.logs[0];
      if (newest && newest.name !== s.logName && s.openedNewest) {
        const b = $('banner');
        b.replaceChildren(el('span', { text: `A new proxy run started (${newest.name}). ` }),
          el('button', { type: 'button', text: 'Switch to it', onclick: () => this.connect(newest.name) }),
          el('button', { type: 'button', class: 'link', text: 'stay here', onclick: () => { b.hidden = true; } }));
        b.hidden = false;
      }
    });
    es.addEventListener('prices', (e) => {
      try { this.prices = JSON.parse(e.data); } catch { return; }
      this.detailFor = null;
      this.invalidate(true);
    });
    es.onerror = () => { $('conn').textContent = es.readyState === EventSource.CLOSED ? '● disconnected' : '● reconnecting…'; };
  },
  onNewRequest() {
    const s = this.state;
    const n = this.newestVisible();
    if (!n || n.id === s.selectedId) return;
    if (s.follow) { s.selectedId = n.id; this.scrollToSel = true; this.dirty.pane = true; }
    else s.newCount++;
  },
  renderRunPicker() {
    const sel = $('run');
    const s = this.state;
    sel.replaceChildren(...s.logs.map((l, i) => el('option', {
      value: l.name, selected: l.name === s.logName,
      text: `${fmtDate(l.start * 1000)} · ${fmtBytes(l.size)} · ${plural(l.exchanges, 'exchange')}${i === 0 ? ' · newest (live)' : ' · read-only'}`,
    })));
    if (!s.logs.length) sel.appendChild(el('option', { text: 'no runs yet' }));
  },
};

// ------------------------------------------------------------------ wiring

$('run').addEventListener('change', (e) => app.connect(e.target.value));
$('run').addEventListener('focus', () => app.refreshLogs());
let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { app.state.search = e.target.value; app.invalidate(false); }, 150);
});
$('pill').addEventListener('click', () => app.resumeLive());
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => app.setTab(b.dataset.tab));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === '/') { e.preventDefault(); $('search').focus(); }
  if (e.key === 'j' || e.key === 'k') {
    const rows = [...document.querySelectorAll('#tree .r-row')];
    const i = rows.findIndex((r) => r.classList.contains('sel'));
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'j' ? 1 : -1)))];
    if (next) app.select(next.dataset.id, { manual: true });
  }
});
// In-flight durations tick once a second.
setInterval(() => {
  if (!app.store.list.some((ex) => !ex.end)) return;
  app.dirty.tree = true;
  const sel = app.store.exchanges.get(app.state.selectedId);
  if (sel && !sel.end) app.store.changed.add(sel.id);
  app.schedule();
}, 1000);

window.app = app; // handy from the devtools console
app.start();
