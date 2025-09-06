// public/js/streamClient.js
export async function streamChat(message, { model, onToken, onDone, onError } = {}) {
  try {
    const res = await fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, ...(model ? { model } : {}) }),
    });
    if (!res.ok || !res.body) {
      onError?.(new Error(`HTTP ${res.status}: ${await res.text()}`));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (frame.startsWith("data:")) {
          const payload = frame.slice(5).trim();
          if (payload === "[DONE]") onDone?.();
          else {
            try {
              const json = JSON.parse(payload);
              if (json.type === "response.output_text.delta" && json.delta) onToken?.(json.delta);
            } catch {}
          }
        }
      }
    }
  } catch (err) { onError?.(err); }
}
