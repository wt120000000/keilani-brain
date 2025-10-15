// /public/js/keilaniStream.v23.js
// Unified SSE client for /api/chat-stream
// Supports 3 formats concurrently:
//  A) event: telemetry|heartbeat|delta|done + data:...
//  B) data starting with [telemetry]|[heartbeat]|[delta]|[done]
//  C) JSON envelope: {"type":"telemetry|heartbeat|delta|done", ...}
//
// Usage in boot.js: import { streamChat } from '/js/keilaniStream.v23.js'

export async function streamChat({
  message,
  userId,
  agent = "keilani",
  onToken,
  onTelemetry,
  onHeartbeat,
  onDone,
  signal
}) {
  if (typeof onToken !== 'function') onToken = () => {};
  if (typeof onTelemetry !== 'function') onTelemetry = () => {};
  if (typeof onHeartbeat !== 'function') onHeartbeat = () => {};
  if (typeof onDone !== 'function') onDone = () => {};

  const res = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, userId, agent }),
    signal
  });

  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${text || 'no body'}`);
  }
  if (!res.body) throw new Error('Response body is not readable (no stream).');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  const parseSSEBlock = (block) => {
    const lines = block.replace(/\r\n/g, '\n').split('\n');
    let evt = null;
    const dataLines = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) evt = line.slice(6).trim().toLowerCase();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    return { evt, data: dataLines.join('\n') };
  };

  const pickMarkerFromBrackets = (d) => {
    const s = (d || '').trim().toLowerCase();
    if (s.startsWith('[telemetry]')) return 'telemetry';
    if (s.startsWith('[heartbeat]')) return 'heartbeat';
    if (s.startsWith('[delta]'))     return 'delta';
    if (s === '[done]' || s.startsWith('[done]')) return 'done';
    if (s === '[done]' || s === '[done]') return 'done';
    return null;
  };

  const handleParsed = (evt, data) => {
    // 1) JSON envelope with .type
    try {
      const obj = JSON.parse(data);
      if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
        const t = obj.type.toLowerCase();
        if (t === 'telemetry') { onTelemetry(obj); return; }
        if (t === 'heartbeat') { onHeartbeat(obj); return; }
        if (t === 'delta') {
          // prefer OpenAI-like shape if present, else "content"
          const delta =
            obj?.choices?.[0]?.delta?.content ??
            (typeof obj.content === 'string' ? obj.content : '');
          if (delta) onToken(delta);
          return;
        }
        if (t === 'done') { onDone(); return; }
      }

      // 2) OpenAI-style without top-level "type"
      const delta2 = obj?.choices?.[0]?.delta?.content;
      if (typeof delta2 === 'string' && delta2.length) {
        onToken(delta2); return;
      }
      // If JSON but not recognized, ignore silently (telemetry variants etc.)
      return;
    } catch {
      // non-JSON — go on to bracket or raw handling
    }

    // 3) Bracket markers in raw strings
    const m = pickMarkerFromBrackets(data);
    if (m === 'telemetry') { onTelemetry(data); return; }
    if (m === 'heartbeat') { onHeartbeat(data); return; }
    if (m === 'done')      { onDone(); return; }
    if (m === 'delta') {
      const token = data.replace(/^\[delta\]\s*/i, '');
      if (token) onToken(token);
      return;
    }

    // 4) event:… with plain data (fallbacks)
    if (evt === 'telemetry') { onTelemetry(data); return; }
    if (evt === 'heartbeat') { onHeartbeat(data); return; }
    if (evt === 'done')      { onDone(); return; }
    if (evt === 'delta' || !evt) {
      // As a last resort, treat data as a token
      if (data && data !== '[DONE]' && data !== '[done]') onToken(data);
      return;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const { evt, data } = parseSSEBlock(frame);
      if (!data) continue;

      if (data === '[DONE]' || data === '[done]') { onDone(); return; }

      handleParsed(evt, data);
    }
  }
}

async function safeReadText(res) {
  try { return await res.text(); } catch { return ''; }
}
