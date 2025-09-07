// public/js/streamClient.js
// Minimal SSE client for /api/chat-stream (Edge) with client-key + request-id support.

export async function streamChat(
  payload,
  { onToken, onDone, onError, onHeaders, signal } = {}
) {
  try {
    const clientKey = localStorage.getItem("KEILANI_PUBLIC_API_KEY") || "";
    if (!clientKey) {
      onError?.(new Error("Missing KEILANI_PUBLIC_API_KEY in localStorage"));
      return;
    }

    const res = await fetch("/api/chat-stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Key": clientKey,
      },
      body: JSON.stringify(payload || {}),
      signal,
    });

    // Pass request-id to UI if present
    const rid =
      res.headers.get("x-openai-request-id") ||
      res.headers.get("openai-request-id") ||
      "";
    if (rid) onHeaders?.(rid);

    if (!res.ok || !res.body) {
      const msg = await res.text().catch(() => "");
      const err = new Error(
        `HTTP ${res.status} ${res.statusText}${
          msg ? `: ${msg.slice(0, 400)}` : ""
        }`
      );
      onError?.(err);
      return;
    }

    // Stream & parse SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!raw) continue;

        // We only care about "data:" lines (ignore "event:")
        const line = raw.startsWith("data:") ? raw.slice(5).trim() : null;
        if (!line) continue;

        if (line === "[DONE]") {
          onDone?.();
          return;
        }

        // OpenAI Responses SSE: JSON objects per frame
        try {
          const json = JSON.parse(line);

          // stream text
          if (
            json.type === "response.output_text.delta" &&
            typeof json.delta === "string"
          ) {
            onToken?.(json.delta);
          }

          // optional: handle other event types as you like
          // e.g. response.error, rate_limits.updated, etc.
        } catch {
          // Non-JSON frame — safely ignore
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
