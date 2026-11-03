// Format adapters (SPEC D2). An adapter turns one raw exchange (request event,
// chunk events, end event) into the neutral model below. Nothing outside this
// file knows what the Anthropic Messages API looks like.
//
// Neutral request:  { model, system: [{text}], tools: [{name, description, schema}],
//                     messages: [{role, blocks}], params, kind: 'messages' | 'count_tokens' }
// Neutral blocks:   text{text} · thinking{text} · tool_call{id,name,input,partial}
//                   tool_result{call_id, content: blocks, is_error} · image{media_type,size} · other{type}
//                   every block also keeps `raw`, the original JSON.
// Neutral reply:    { blocks, stop_reason, error, model, done }
// Reply state (newReply) must expose `closed`: the number of blocks that have
// finished streaming, so tool calls can be registered before the reply ends.
// Neutral usage:    { input, output, cache_read, cache_write }

// ---------------------------------------------------------------- Anthropic

function textOf(v) {
  return typeof v === 'string' ? v : '';
}

export function anthropicBlock(b) {
  if (typeof b === 'string') return { kind: 'text', text: b, raw: b };
  if (!b || typeof b !== 'object') return { kind: 'other', type: typeof b, raw: b };
  switch (b.type) {
    case 'text':
      return { kind: 'text', text: textOf(b.text), raw: b };
    case 'thinking':
      return { kind: 'thinking', text: textOf(b.thinking), raw: b };
    case 'redacted_thinking':
      return { kind: 'thinking', text: '[redacted thinking]', redacted: true, raw: b };
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return { kind: 'tool_call', id: b.id, name: b.name || '?', input: b.input, server: b.type !== 'tool_use', raw: b };
    case 'tool_result':
    case 'mcp_tool_result':
      return {
        kind: 'tool_result', call_id: b.tool_use_id, is_error: !!b.is_error,
        content: anthropicContent(b.content), raw: b,
      };
    case 'image': {
      const src = b.source || {};
      return { kind: 'image', media_type: src.media_type || src.type || 'image', size: (src.data || '').length * 0.75, raw: b };
    }
    default:
      // Server tool results (web_search_tool_result, ...) answer a server_tool_use.
      if (typeof b.type === 'string' && b.type.endsWith('_tool_result') && b.tool_use_id) {
        return { kind: 'tool_result', call_id: b.tool_use_id, is_error: false, content: [{ kind: 'other', type: b.type, raw: b.content }], raw: b };
      }
      return { kind: 'other', type: b.type || 'unknown', raw: b };
  }
}

export function anthropicContent(c) {
  if (c == null) return [];
  if (typeof c === 'string') return [{ kind: 'text', text: c, raw: c }];
  if (Array.isArray(c)) return c.map(anthropicBlock);
  return [anthropicBlock(c)];
}

const MESSAGES_PATH = /^\/v1\/messages(\/count_tokens)?\/?(\?|$)/;

export const anthropic = {
  name: 'anthropic',

  matches(req) {
    return req.method === 'POST' && MESSAGES_PATH.test(req.path || '') &&
      req.body && typeof req.body === 'object' && Array.isArray(req.body.messages);
  },

  parseRequest(req) {
    const body = req.body;
    const kind = MESSAGES_PATH.exec(req.path)[1] ? 'count_tokens' : 'messages';
    let system = [];
    if (typeof body.system === 'string') system = [{ text: body.system, raw: body.system }];
    else if (Array.isArray(body.system)) {
      system = body.system.map((b) => ({ text: typeof b === 'string' ? b : textOf(b?.text) || JSON.stringify(b), raw: b }));
    }
    const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => ({
      name: t.name || t.type || '?',
      description: textOf(t.description),
      schema: t.input_schema ?? null,
      raw: t,
    }));
    const messages = body.messages.map((m) => ({ role: m.role, blocks: anthropicContent(m.content), raw: m }));
    const params = {};
    for (const [k, v] of Object.entries(body)) if (!['system', 'tools', 'messages'].includes(k)) params[k] = v;
    return { kind, model: body.model || '?', system, tools, messages, params, stream: !!body.stream };
  },

  // Rebuilding a streamed reply. The state is fed every chunk as it arrives,
  // so the UI can show the reply while it is still being written.
  newReply() {
    return {
      mode: null, // 'sse' | 'json'
      buf: '', text: '', blocks: [], partial: [], stop_reason: null, error: null,
      model: null, id: null, usage: null, events: 0, counted: null,
      closed: 0, // number of content blocks that have finished streaming
    };
  },

  feed(st, data) {
    if (st.mode == null) {
      const t = (st.buf + data).trimStart();
      if (!t) { st.buf += data; return; }
      st.mode = t[0] === '{' || t[0] === '[' ? 'json' : 'sse';
    }
    if (st.mode === 'json') { st.text += st.buf + data; st.buf = ''; return; }
    st.buf += data;
    // SSE events are separated by a blank line.
    for (;;) {
      const m = /\r?\n\r?\n/.exec(st.buf);
      if (!m) break;
      const raw = st.buf.slice(0, m.index);
      st.buf = st.buf.slice(m.index + m[0].length);
      this.sseEvent(st, raw);
    }
  },

  sseEvent(st, raw) {
    let event = 'message';
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let ev;
    try { ev = JSON.parse(data.join('\n')); } catch { return; }
    st.events++;
    const type = ev.type || event;
    switch (type) {
      case 'message_start': {
        const msg = ev.message || {};
        st.model = msg.model || st.model;
        st.id = msg.id || st.id;
        st.usage = mergeUsage(st.usage, msg.usage);
        if (Array.isArray(msg.content)) for (const b of msg.content) st.blocks.push(b);
        break;
      }
      case 'content_block_start':
        st.blocks[ev.index] = { ...(ev.content_block || {}) };
        if (st.blocks[ev.index].type === 'tool_use' || st.blocks[ev.index].type === 'server_tool_use' || st.blocks[ev.index].type === 'mcp_tool_use') {
          st.partial[ev.index] = '';
        }
        break;
      case 'content_block_delta': {
        const b = st.blocks[ev.index] || (st.blocks[ev.index] = { type: 'text', text: '' });
        const d = ev.delta || {};
        if (d.type === 'text_delta') b.text = (b.text || '') + (d.text || '');
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
        else if (d.type === 'signature_delta') b.signature = (b.signature || '') + (d.signature || '');
        else if (d.type === 'input_json_delta') st.partial[ev.index] = (st.partial[ev.index] || '') + (d.partial_json || '');
        else if (d.type === 'citations_delta') (b.citations ||= []).push(d.citation);
        break;
      }
      case 'content_block_stop': {
        const b = st.blocks[ev.index];
        if (b && st.partial[ev.index] != null) {
          const s = st.partial[ev.index];
          try { b.input = s ? JSON.parse(s) : (b.input ?? {}); } catch { b.input = s; }
          st.partial[ev.index] = null;
        }
        st.closed++;
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) st.stop_reason = ev.delta.stop_reason;
        st.usage = mergeUsage(st.usage, ev.usage);
        break;
      case 'error':
        st.error = ev.error?.message ? `${ev.error.type || 'error'}: ${ev.error.message}` : JSON.stringify(ev.error || ev);
        break;
      default:
        break; // ping, message_stop
    }
  },

  finish(st) {
    if (st.mode === 'sse' && st.buf.trim()) { this.sseEvent(st, st.buf); st.buf = ''; }
    if (st.mode === 'json' && st.text) {
      let j;
      try { j = JSON.parse(st.text); } catch { return; }
      if (j.type === 'message') {
        st.blocks = Array.isArray(j.content) ? j.content : [];
        st.stop_reason = j.stop_reason;
        st.model = j.model;
        st.usage = mergeUsage(null, j.usage);
      } else if (j.type === 'error' || j.error) {
        st.error = j.error?.message ? `${j.error.type || 'error'}: ${j.error.message}` : JSON.stringify(j.error || j);
      } else if (typeof j.input_tokens === 'number') {
        st.counted = j.input_tokens; // count_tokens answer: not a model reply, not billed
      }
    }
  },

  // Neutral view of the reply as it stands right now.
  reply(st, done) {
    const blocks = [];
    st.blocks.forEach((b, i) => {
      if (!b) return;
      const nb = anthropicBlock(b);
      if (nb.kind === 'tool_call' && st.partial[i] != null) {
        nb.partial = st.partial[i];
        nb.input = undefined;
      }
      blocks.push(nb);
    });
    return { blocks, stop_reason: st.stop_reason, error: st.error, model: st.model, done, counted: st.counted };
  },

  usage(st) {
    return st.usage;
  },
};

function mergeUsage(u, src) {
  if (!src) return u;
  const out = u ? { ...u } : { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const map = { input_tokens: 'input', output_tokens: 'output', cache_read_input_tokens: 'cache_read', cache_creation_input_tokens: 'cache_write' };
  for (const [k, n] of Object.entries(map)) if (typeof src[k] === 'number') out[n] = src[k];
  return out;
}

// --------------------------------------------------------------- registry

// A Codex / OpenAI Responses adapter would be added here (SPEC D2); nothing else changes.
export const ADAPTERS = [anthropic];

export function adapterFor(req) {
  return ADAPTERS.find((a) => a.matches(req)) || null;
}

// Body of an unrecognised exchange, for the raw view.
export function rawRequestBody(req) {
  if ('body' in req) return { json: req.body };
  if ('body_text' in req) return { text: req.body_text };
  if ('body_b64' in req) return { text: `[binary, ${req.body_b64.length} base64 chars]` };
  return null;
}
