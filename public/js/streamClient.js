// public/js/streamClient.js
// SSE client for /api/chat-stream with client-key, request-id callback,
// and robust CRLF/LF frame parsing.

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

    // Surface request id (if exposed by server)
    const rid =
      res.headers.get("x-openai-request-id") ||
      res.headers.get("openai-request-id") ||
      "";
    if (rid) onHeaders?.(rid);

    if (!res.ok || !res.body) {
      const msg = await res.text().catch(() => "");
      onError?.(
        new Error(
          `HTTP ${res.status} ${res.statusText}${
            msg ? `: ${msg.slice(0, 400)}` : ""
          }`
        )
      );
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    // helper: find next SSE frame boundary supporting LF and CRLF
    function findBoundary(b) {
      const a = b.indexOf("\n\n");      // LF LF
      const c = b.indexOf("\r\n\r\n");  // CRLF CRLF
      if (a === -1 && c === -1) return { idx: -1, sepLen: 0 };
      if (a === -1) return { idx: c, sepLen: 4 };
      if (c === -1) return { idx: a, sepLen: 2 };
      // choose earliest
      return a < c ? { idx: a, sepLen: 2 } : { idx: c, sepLen: 4 };
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const { idx, sepLen } = findBoundary(buffer);
        if (idx === -1) break; // need more data

        const chunk = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + sepLen);

        if (!chunk) continue;

        // We care about "data:" lines (ignore "event:" etc.)
        // Some servers may send multi-line frames; split by CRLF or LF.
        const lines = chunk.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();

          if (payload === "[DONE]") {
            onDone?.();
            return;
          }

          try {
            const json = JSON.parse(payload);

            if (
              json.type === "response.output_text.delta" &&
              typeof json.delta === "string"
            ) {
              onToken?.(json.delta);
            }

            // Optional: handle other event types if you need them:
            // - response.completed
            // - response.error
            // - rate_limits.updated
            // - etc.
          } catch {
            // Non-JSON data line — safely ignore.
          }
        }
      }
    }

    // If we exit the read loop without an explicit [DONE], still finish.
    onDone?.();
  } catch (err) {
    if (err?.name === "AbortError") {
      onError?.(new Error("Aborted"));
    } else {
      onError?.(err);
    }
  }
}
