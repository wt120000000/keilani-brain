// /public/js/keilaniStream.v24.js
// v24: robust SSE with heartbeat timeout + limited auto-retry
//
// Supported server formats:
//  A) event: telemetry|heartbeat|delta|done + data:...
//  B) data starts with [telemetry]|[heartbeat]|[delta]|[done]
//  C) JSON envelope: {"type":"telemetry|heartbeat|delta|done", ...}
//  D) OpenAI-style delta: {"choices":[{"delta":{"content":"..."}}]}
//
// API:
//   import { streamChat } from '/js/keilaniStream.v24.js'
//   await streamChat({ message, userId, agent, signal,
//                      onToken, onTelemetry, onHeartbeat, onDone })
//
// Behavior:
// - Times out if no heartbeat within HEARTBEAT_TIMEOUT_MS
// - One auto-retry (exponential backoff) on transient network failure

export async function streamChat(opts) {
  const {
    message,
    userId,
    agent = "keilani",
    onToken = () => {},
    onTelemetry = () => {},
    onHeartbeat = () => {},
    onDone = () => {},
    signal,
    HEARTBEAT_TIMEOUT_MS = 25000,
    RETRIES = 1
  } = opts;

  let attempt = 0;
  while (true) {
    try {
      return await runOnce({
        message, userId, agent, onToken, onTelemetry, onHeartbeat, onDone,
        signal, HEARTBEAT_TIMEOUT_MS
      });
    } catch (err) {
      // Abort or no more retries → bubble up
      if (signal?.aborted) throw err;
      if (attempt >= RETRIES) throw err;

      // Basic exponential backoff: 500ms, then 1s
      const delay = 500 * Math.pow(2, attempt);
      await sleep(delay);
      attempt++;
    }
  }
}

async function runOnce({
  message, userId, agent, onToken, onTelemetry, onHeartbeat, onDone, signal,
  HEARTBEAT_TIMEOUT_MS
}) {
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

  // Heartbeat watchdog
  let lastBeat = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastBeat > HEARTBEAT_TIMEOUT_MS) {
      clearInterval(watchdog);
      try { reader.cancel(); } catch {}
      throw new Error('Heartbeat timeout');
    }
  }, Math.min(HEARTBEAT_TIMEOUT_MS, 5000));

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

  const pickBracketMarker = (s) => {
    const d = (s || '').trim().toLowerCase();
    if (d.startsWith('[telemetry]')) return 'telemetry';
    if (d.startsWith('[heartbeat]')) return 'heartbeat';
    if (d.startsWith('[delta]'))     return 'delta';
    if (d === '[done]' || d.startsWith('[done]')) return 'done';
    return null;
  };

  const handle = (evt, data) => {
    // Heartbeat bookkeeping (any activity counts)
    lastBeat = Date.now();

    // JSON envelope?
    try {
      const obj = JSON.parse(data);
      if (obj && typeof obj === 'object') {
        if (typeof obj.type === 'string') {
          const t = obj.type.toLowerCase();
          if (t === 'telemetry') { onTelemetry(obj); return; }
          if (t === 'heartbeat') { onHeartbeat(obj); return; }
          if (t === 'delta') {
            const delta = obj?.choices?.[0]?.delta?.content ?? (obj.content || '');
            if (delta) onToken(delta);
            return;
          }
          if (t === 'done') { onDone(); return; }
        }
        // OpenAI-like (no .type)
        const delta2 = obj?.choices?.[0]?.delta?.content;
        if (typeof delta2 === 'string' && delta2.length) { onToken(delta2); return; }
        return; // other JSON → ignore quietly
      }
    } catch { /* not JSON */ }

    // Bracket markers
    const m = pickBracketMarker(data);
    if (m === 'telemetry') { onTelemetry(data); return; }
    if (m === 'heartbeat') { onHeartbeat(data); return; }
    if (m === 'done')      { onDone(); return; }
    if (m === 'delta') {
      onToken(data.replace(/^\[delta\]\s*/i, ''));
      return;
    }

    // event:… fallback
    if (evt === 'telemetry') { onTelemetry(data); return; }
    if (evt === 'heartbeat') { onHeartbeat(data); return; }
    if (evt === 'done')      { onDone(); return; }
    // default: treat as token
    if (data && data !== '[DONE]' && data !== '[done]') onToken(data);
  };

  try {
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
        if (data === '[DONE]' || data === '[done]') { onDone(); clearInterval(watchdog); return; }

        handle(evt, data);
      }
    }
  } finally {
    clearInterval(watchdog);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function safeReadText(res) { try { return await res.text(); } catch { return ''; } }
