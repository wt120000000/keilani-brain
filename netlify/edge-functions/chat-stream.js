// netlify/edge-functions/chat-stream.js
const MODEL  = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const API_KEY = Deno.env.get("OPENAI_API_KEY")   || "";

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

export default async (request) => {
  // --- Parse body robustly ---------------------------------------------------
  let raw = "";
  try { raw = await request.text(); } catch {/* keep empty */ }

  let payload = {};
  if (raw) {
    // Try JSON first, then URL-encoded (curl -d key=val style)
    try {
      payload = JSON.parse(raw);
    } catch {
      try {
        const params = new URLSearchParams(raw);
        payload = Object.fromEntries(params.entries());
      } catch {/* ignore */}
    }
  }

  const { message, userId, agent = "keilani" } = payload ?? {};

  if (!message || !userId) {
    // Show exactly what the edge received so we can see quoting/curl issues
    return new Response(
      JSON.stringify({ error: "missing_fields", detail: "Provide { message, userId }", received: { raw, parsed: payload } }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive"
  });

  // --- No key? Send a friendly stub so the UI still moves --------------------
  if (!API_KEY) {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));
        c.enqueue(sse({ type: "delta", content: `Hi ${userId}! (OPENAI_API_KEY missing)\n` }));
        c.enqueue(sse({ type: "done" })); c.close();
      }
    });
    return new Response(body, { status: 200, headers });
  }

  // --- Relay OpenAI stream → SSE --------------------------------------------
  const system = `You are ${agent}, a helpful, upbeat AI influencer. Keep it concise.`;

  const body = new ReadableStream({
    async start(c) {
      c.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));

      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "authorization": `Bearer ${API_KEY}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: MODEL,
            stream: true,
            messages: [
              { role: "system", content: system },
              { role: "user",   content: message }
            ]
          })
        });

        if (!resp.ok || !resp.body) {
          const txt = await resp.text().catch(() => "(no body)");
          c.enqueue(sse({ type: "delta", content: `OpenAI error: ${resp.status} ${txt}\n` }));
          c.enqueue(sse({ type: "done" })); c.close(); return;
        }

        const reader  = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Split SSE frames
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? ""; // keep tail partial

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();

            if (data === "[DONE]") {
              c.enqueue(sse({ type: "done" })); c.close(); return;
            }

            try {
              const json  = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) c.enqueue(sse({ type: "delta", content: delta }));
            } catch {/* ignore control frames */}
          }
        }

        c.enqueue(sse({ type: "done" })); c.close();
      } catch (err) {
        c.enqueue(sse({ type: "delta", content: `Edge exception: ${String(err)}\n` }));
        c.enqueue(sse({ type: "done" })); c.close();
      }
    }
  });

  return new Response(body, { status: 200, headers });
};
