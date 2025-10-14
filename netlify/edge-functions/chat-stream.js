// netlify/edge-functions/chat-stream.js
const MODEL = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

const PAD = (":\r\n").repeat(1024); // ~2KB SSE padding to defeat proxy buffering

const sse = (obj) => `data: ${JSON.stringify(obj)}\r\n\r\n`;

async function readJson(req) {
  try {
    const txt = await req.clone().text();
    return txt ? JSON.parse(txt) : {};
  } catch { return {}; }
}

export default async (request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  const payload = await readJson(request);
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
    "x-accel-buffering": "no" // discourage proxy buffering
  });

  // No key? return a friendly stream so the UI still moves.
  if (!API_KEY) {
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(PAD);
        ctrl.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));
        ctrl.enqueue(sse({ type: "delta", content: "⚠️ No OPENAI_API_KEY set.\n" }));
        ctrl.enqueue(sse({ type: "done" }));
        ctrl.close();
      }
    });
    return new Response(body, { headers });
  }

  const body = new ReadableStream({
    async start(ctrl) {
      // padding + immediate ticks so the browser starts rendering
      ctrl.enqueue(PAD);
      ctrl.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));
      ctrl.enqueue(sse({ type: "delta", content: "..." }));

      // heartbeat every second (helps some proxies/browsers keep streaming)
      const hb = setInterval(() => {
        try { ctrl.enqueue(sse({ type: "ping", ts: Date.now() })); } catch {}
      }, 1000);

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
          const text = await resp.text().catch(() => "(no body)");
          ctrl.enqueue(sse({ type: "delta", content: `❌ OpenAI error: ${resp.status} ${text}\n` }));
          ctrl.enqueue(sse({ type: "done" }));
          clearInterval(hb);
          ctrl.close();
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
              ctrl.enqueue(sse({ type: "done" }));
              clearInterval(hb);
              ctrl.close();
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) ctrl.enqueue(sse({ type: "delta", content: delta }));
            } catch { /* ignore keepalives/non-JSON frames */ }
          }

          // tiny yield to help Firefox flush
          await new Promise(r => setTimeout(r, 25));
        }

        ctrl.enqueue(sse({ type: "done" }));
        clearInterval(hb);
        ctrl.close();
      } catch (err) {
        ctrl.enqueue(sse({ type: "delta", content: `Edge exception: ${String(err)}\n` }));
        ctrl.enqueue(sse({ type: "done" }));
        clearInterval(hb);
        ctrl.close();
      }
    }
  });

  return new Response(body, { headers });
};
