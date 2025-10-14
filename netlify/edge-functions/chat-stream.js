// netlify/edge-functions/chat-stream.js
const MODEL = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

// SSE helper
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\r\n\r\n`;
}

// Safely parse JSON body
async function parseBody(req) {
  try {
    const clone = req.clone();
    const txt = await clone.text();
    if (!txt) return {};
    try { return JSON.parse(txt); } catch { return {}; }
  } catch {
    return {};
  }
}

export default async (request, _context) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  const payload = await parseBody(request);
  const { message, userId, agent = "keilani" } = payload || {};

  if (!message || !userId) {
    return new Response(
      JSON.stringify({ error: "missing_fields", detail: "Provide { message, userId }", received: payload }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no" // disables buffering in some proxies
  });

  // Handle missing API key
  if (!API_KEY) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));
        controller.enqueue(sse({ type: "delta", content: "⚠️ No OPENAI_API_KEY set.\n" }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      }
    });
    return new Response(body, { headers });
  }

  // Streaming logic
  const body = new ReadableStream({
    async start(controller) {
      // initial tick so browser starts rendering
      controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));
      controller.enqueue(sse({ type: "delta", content: "..." }));

      const systemPrompt = `You are ${agent}, a helpful, upbeat AI influencer. Keep it concise.`;

      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${API_KEY}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: MODEL,
            stream: true,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: message }
            ]
          })
        });

        if (!resp.ok || !resp.body) {
          const errText = await resp.text().catch(() => "(no body)");
          controller.enqueue(sse({ type: "delta", content: `❌ OpenAI error: ${resp.status} ${errText}\n` }));
          controller.enqueue(sse({ type: "done" }));
          controller.close();
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (!part.startsWith("data:")) continue;
            const data = part.slice(5).trim();

            if (data === "[DONE]") {
              controller.enqueue(sse({ type: "done" }));
              controller.close();
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(sse({ type: "delta", content: delta }));
            } catch (_) {
              // ignore non-JSON keepalive frames
            }
          }

          // small forced flush for Firefox & Netlify edge
          await new Promise((res) => setTimeout(res, 25));
        }

        controller.enqueue(sse({ type: "done" }));
        controller.close();
      } catch (err) {
        controller.enqueue(sse({ type: "delta", content: `Edge exception: ${String(err)}\n` }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      }
    }
  });

  return new Response(body, { headers });
};
