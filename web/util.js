// Small shared helpers. All DOM is built with createElement + textContent:
// captured traffic is untrusted and is never inserted as HTML (SPEC D4).

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'title') node.title = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

export const nf = new Intl.NumberFormat('en-US');
export const fmtInt = (n) => (n == null ? '–' : nf.format(Math.round(n)));

export function fmtTokens(n) {
  if (n == null) return '–';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

export function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return '–';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  return `${m}m${Math.round((ms % 60000) / 1000)}s`;
}

export function fmtUsd(x) {
  if (x == null) return '–';
  if (x === 0) return '$0';
  if (x < 0.01) return '$' + x.toFixed(4);
  if (x < 10) return '$' + x.toFixed(3);
  return '$' + x.toFixed(2);
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1 << 20) return (n / 1024).toFixed(1) + ' kB';
  return (n / (1 << 20)).toFixed(1) + ' MB';
}

export function fmtClock(t) {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

export function fmtDate(t) {
  const d = new Date(t);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour12: false });
}

export function wordCount(s) {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

export function oneLine(s, max = 60) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function plural(n, word, pl) {
  return `${fmtInt(n)} ${n === 1 ? word : pl || word + 's'}`;
}

// cyrb53: fast 53-bit string hash, used to compare messages without keeping copies.
export function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) flash(button, 'copied');
  } catch {
    // Fallback for browsers that refuse the async clipboard API.
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); if (button) flash(button, 'copied'); } catch { if (button) flash(button, 'failed'); }
    ta.remove();
  }
}

function flash(button, msg) {
  const old = button.textContent;
  button.textContent = msg;
  setTimeout(() => { button.textContent = old; }, 900);
}

export function copyButton(getText, label = 'copy') {
  const b = el('button', { class: 'copy', type: 'button', title: 'Copy to clipboard', text: label });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    copyText(typeof getText === 'function' ? getText() : getText, b);
  });
  return b;
}

export function stringify(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
