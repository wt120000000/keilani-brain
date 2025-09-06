// public/js/streamClient.js
// Minimal SSE client for /api/chat-stream (Edge). Also works in Node with fetch streams.

export async function streamChat(payload, { onToken, onDone, onError, signal } = {}) {
  try {
    const res = await fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      onError?.(new Error(`HTTP ${res.status} ${res.statusText}: ${text}`));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by blank lines
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);

        if (!frame) continue;

        // We only care about `data:` lines; `event:` are informational
        if (frame.startsWith("data:")) {
          const payload = frame.slice(5).trim();
          if (payload === "[DONE]") {
            onDone?.();
            return;
          }

          // OpenAI Responses streaming emits JSON chunks
          try {
            const json = JSON.parse(payload);
            if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
              onToken?.(json.delta);
            }
            // You can handle other event types here if you want
          } catch {
            // non-JSON data line — ignore
          }
        }
      }
    }

    onDone?.();
  } catch (err) {
    if (err?.name === "AbortError") {
      onError?.(new Error("Aborted"));
    } else {
      onError?.(err);
    }
  }
}
