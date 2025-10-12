// Robust SSE reader for /api/chat-stream
// Usage:
//   import { streamChat } from '/js/keilaniStream.v21.js'
//   streamChat({ message, userId, onToken, signal })

export async function streamChat({ message, userId, onToken, signal }) {
  if (typeof onToken !== 'function') onToken = () => {};

  const res = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, userId }),
    signal
  });

  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${text || 'no body'}`);
  }
  if (!res.body) {
    throw new Error('Response body is not readable (no stream).');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    // Split on SSE frame delimiter: double newline
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      // Normalize CRLF → LF and trim
      const lines = frame.replace(/\r\n/g, '\n').trim().split('\n');

      // Extract only `data:` lines (ignore comments / other fields)
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trimStart(); // after "data:"

        if (payload === '[DONE]') {
          // graceful end
          return;
        }

        // Some frames can be telemetry or keep-alives; ignore if not JSON
        try {
          const obj = JSON.parse(payload);

          // OpenAI-like delta content
          const delta = obj?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) onToken(delta);

          // If you want to tap telemetry frames:
          // if (obj?.type === 'telemetry') { /* optional: handle */ }
        } catch {
          // Non-JSON payload (keep-alive/telemetry)—safely ignore
        }
      }
    }
  }
}

async function safeReadText(res) {
  try { return await res.text(); } catch { return ''; }
}
