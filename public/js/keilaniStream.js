// public/js/keilaniStream.js
export async function streamKeilani(message, {
  url = "/api/chat-stream",
  onToken = () => {},
  onDone = () => {},
  onError = (e) => console.error(e),
  signal
} = {}) {
  const ctrl = new AbortController();
  if (signal) signal.addEventListener('abort', () => ctrl.abort());

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: ctrl.signal
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) onToken(delta);
        } catch { /* ignore keepalives */ }
      }
    }
    onDone();
  } catch (e) {
    onError(e);
  }

  return () => ctrl.abort(); // return a cancel fn
}
