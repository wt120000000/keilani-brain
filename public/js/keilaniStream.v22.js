// /public/js/keilaniStream.v22.js
// Unified SSE client for /api/chat-stream with telemetry/heartbeat/delta/done
// Usage in boot.js: import { streamChat } from '/js/keilaniStream.v22.js'

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

  const pickMarker = ({ evt, data }) => {
    if (evt) return evt; // telemetry|heartbeat|delta|done
    const d = (data || '').trim().toLowerCase();
    if (d.startsWith('[telemetry]')) return 'telemetry';
    if (d.startsWith('[heartbeat]')) return 'heartbeat';
    if (d.startsWith('[delta]')) return 'delta';
    if (d === '[done]' || d.startsWith('[done]') || d === '[done]') return 'done';
    if (d === '[done]' || d === '[done]') return 'done';
    return 'delta';
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

      if (data === '[DONE]' || data === '[done]') {
        onDone();
        return;
      }

      const marker = pickMarker({ evt, data });

      let parsed = null;
      try { parsed = JSON.parse(data); } catch { /* non-JSON */ }

      if (marker === 'telemetry') { onTelemetry(parsed ?? data); continue; }
      if (marker === 'heartbeat') { onHeartbeat(parsed ?? data); continue; }
      if (marker === 'done') { onDone(); return; }

      // DELTA
      if (parsed && parsed.choices?.[0]?.delta?.content) {
        const delta = parsed.choices[0].delta.content;
        if (typeof delta === 'string' && delta.length) onToken(delta);
      } else {
        const token = data.replace(/^\[delta\]\s*/i, '');
        if (token) onToken(token);
      }
    }
  }
}

async function safeReadText(res) {
  try { return await res.text(); } catch { return ''; }
}
