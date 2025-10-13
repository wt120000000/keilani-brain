// netlify/edge-functions/chat-stream.js

// --- config from env with safe defaults
const MODEL  = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const APIKEY = Deno.env.get("OPENAI_API_KEY") || "";

// tiny helper to emit SSE frames
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

// robust body parser: JSON or text; tolerate empty
async function parseBody(req) {
  try {
    // Some edge runtimes require cloning before multiple reads
    const clone = req.clone();

    // Try JSON first
    try { return await clone.json(); } catch (_) {}

    // Then raw text → JSON
    const txt = await req.text();
    if (typeof txt === "string" && txt.trim()) {
      try { return JSON.parse(txt); } catch (_) {}
    }
  } catch (_) {}
  return {};
}

export default async (request, _context) => {
  // Only POST
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  const payload = await parseBody(request);
  const message = payload?.message;
  const userId  = payload?.userId;
  const agent   = payload?.agent ?? "keilani";

  if (!message || !userId) {
    return new Response(
      JSON.stringify({
        error: "missing_fields",
        detail: "Provide { message, userId }",
        received: typeof payload === "object" ? payload : { type: typeof payload }
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  // Prepare SSE headers
  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive"
  });

  // If we have no OpenAI key, still send a friendly stream so the UI moves
  if (!APIKEY) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));
        controller.enqueue(sse({ type: "delta", content: "Hi! (OPENAI_API_KEY not set)\n" }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      }
    });
    return new Response(body, { status: 200, headers });
  }

  // Stream OpenAI → relay as SSE frames {type:"delta", content:"..."}
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));

      const system = `You are ${agent}, a helpful, upbeat AI influencer. Keep it concise.`;

      try {
        const oai = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "authorization": `Bearer ${APIKEY}`,
            "content-type":  "application/json"
          },
          body: JSON.stringify({
            model:   MODEL,
            stream:  true,
            messages: [
              { role: "system", content: system },
              { role: "user",   content: message }
            ]
          })
        });

        if (!oai.ok || !oai.body) {
          const text = await oai.text().catch(() => "(no body)");
          controller.enqueue(sse({ type: "delta", content: `OpenAI error: ${oai.status} ${text}\n` }));
          controller.enqueue(sse({ type: "done" }));
          controller.close();
          return;
        }

        const reader  = oai.body.getReader();
        const decoder = new TextDecoder();
        let   buffer  = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Split by blank lines — OpenAI sends "data: {...}\n\n"
          const chunks = buffer.split("\n\n");
          const tail   = chunks.pop();
          buffer = (tail !== undefined ? tail : "");

          for (const chunk of chunks) {
            const line = chunk.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();

            if (data === "[DONE]") {
              controller.enqueue(sse({ type: "done" }));
              controller.close();
              return;
            }

            try {
              const json  = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(sse({ type: "delta", content: delta }));
            } catch {
              // Ignore keepalives/trace lines
            }
          }
        }

        // Graceful close if the upstream ended without a terminal frame
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      } catch (err) {
        controller.enqueue(sse({ type: "delta", content: `Edge exception: ${String(err)}\n` }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      }
    }
  });

  return new Response(body, { status: 200, headers });
};
