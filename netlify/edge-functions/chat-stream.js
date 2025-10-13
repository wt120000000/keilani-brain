// netlify/edge-functions/chat-stream.js

const MODEL  = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

// Small helper to format Server-Sent Events frames
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Common headers for SSE + light CORS (useful for curl/manual tests)
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "vary": "origin",
};

export default async (request, context) => {
  // Allow preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "method_not_allowed" }),
      { status: 405, headers: { "content-type": "application/json", ...CORS } }
    );
  }

  // --- IMPORTANT: manually parse JSON body (works reliably in Edge runtimes)
  let payload = {};
  try {
    const text = await request.text();           // get raw body
    payload = text ? JSON.parse(text) : {};      // parse (may throw)
  } catch (_err) {
    // leave payload as {}
  }

  const { message, userId, agent = "keilani" } = payload ?? {};
  if (!message || !userId) {
    return new Response(
      JSON.stringify({
        error: "missing_fields",
        detail: "Provide { message, userId }",
        received: payload,
      }),
      { status: 400, headers: { "content-type": "application/json", ...CORS } }
    );
  }

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    ...CORS,
  });

  // If no key is set, return a friendly streamed placeholder so the UI keeps moving
  if (!API_KEY) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));
        controller.enqueue(sse({ type: "delta", content: "Hi! (no OPENAI_API_KEY set)\n" }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      },
    });
    return new Response(body, { headers, status: 200 });
  }

  // Relay OpenAI stream → our SSE format
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));

      // Optional: lightweight heartbeat to keep some proxies from idling out
      const heartbeat = setInterval(() => controller.enqueue(": ping\n\n"), 15000);

      const system = `You are ${agent}, a helpful, upbeat AI influencer. Keep it concise.`;

      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            stream: true,
            messages: [
              { role: "system", content: system },
              { role: "user", content: message },
            ],
          }),
        });

        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => "(no body)");
          controller.enqueue(sse({ type: "delta", content: `OpenAI error: ${resp.status} ${text}\n` }));
          controller.enqueue(sse({ type: "done" }));
          clearInterval(heartbeat);
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

          // OpenAI SSE frames are split by \n\n and each line starts with "data: "
          const parts = buffer.split("\n\n");
          const rest = parts.pop();          // last partial (may be undefined)
          buffer = rest !== undefined ? rest : "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              controller.enqueue(sse({ type: "done" }));
              clearInterval(heartbeat);
              controller.close();
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(sse({ type: "delta", content: delta }));
            } catch {
              // Ignore non-JSON control lines
            }
          }
        }

        // Graceful close if upstream ended without an explicit [DONE]
        controller.enqueue(sse({ type: "done" }));
        clearInterval(heartbeat);
        controller.close();
      } catch (err) {
        controller.enqueue(sse({ type: "delta", content: `Edge exception: ${String(err)}\n` }));
        controller.enqueue(sse({ type: "done" }));
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(body, { headers, status: 200 });
};
