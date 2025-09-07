// public/js/streamClient.js
// Minimal SSE client for /api/chat-stream (Edge) with optional auth + headers callback.

function getClientKey() {
  // Prefer a global override, then localStorage, else empty.
  return (
    (typeof window !== "undefined" && window.KEILANI_PUBLIC_API_KEY) ||
    (typeof localStorage !== "undefined" && localStorage.getItem("KEILANI_PUBLIC_API_KEY")) ||
    ""
  );
}

/**
 * streamChat(payload, options?)
 * payload: { message, model, temperature, max_output_tokens, ... }
 * options:
 *   - endpoint: string (default "/api/chat-stream")
 *   - onToken(text): called for each output_text delta
 *   - onDone(): called when stream completes
 *   - onError(err): called on error
 *   - onHeaders(reqId, res): called once after fetch with request id (if any)
 *   - signal: AbortSignal
 */
export async function streamChat(
  payload,
  { endpoint = "/api/chat-stream", onToken, onDone, onError, onHeaders, signal } = {}
) {
  try {
    const key = getClientKey();

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Attach the shared client key if present
        ...(key ? { "X-Client-Key": key } : {}),
      },
      body: JSON.stringify(payload || {}),
      signal,
    });

    // Surface the OpenAI request id, if our edge exposed it
    try {
      const reqId =
        res.headers.get("x-openai-request-id") ||
        res.headers.get("openai-request-id") ||
        "";
      if (reqId && typeof onHeaders === "function") onHeaders(reqId, res);
    } catch {}

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
          const dataStr = frame.slice(5).trim();

          if (dataStr === "[DONE]") {
            onDone?.();
            return;
          }

          // OpenAI Responses streaming emits JSON chunks
          try {
            const json = JSON.parse(dataStr);
            if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
              onToken?.(json.delta);
            }
            // Handle other event types if you want
          } catch {
            // Non-JSON data line — ignore
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
