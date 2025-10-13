const MODEL = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

function sse(obj){ return `data: ${JSON.stringify(obj)}\n\n`; }

export default async (request, context) => {
  // Ensure POST + JSON body
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { "content-type": "application/json" }
    });
  }

  let payload = {};
  try { payload = await request.json(); } catch {}
  const { message, userId, agent = "keilani" } = payload ?? {};
  if (!message || !userId) {
    return new Response(JSON.stringify({ error: "missing_fields", detail: "Provide { message, userId }" }), {
      status: 400, headers: { "content-type": "application/json" }
    });
  }

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive"
  });

  // If no key, fall back to a hello so UX still moves
  if (!API_KEY) {
    const body = new ReadableStream({
      start(controller){
        controller.enqueue(sse({ type:"telemetry", model: MODEL, ts: new Date().toISOString() }));
        controller.enqueue(sse({ type:"delta", content: "Hi! (no OPENAI_API_KEY set)\n" }));
        controller.enqueue(sse({ type:"done" }));
        controller.close();
      }
    });
    return new Response(body, { headers, status: 200 });
  }

  // Relay OpenAI stream → our SSE format
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({ type:"telemetry", model: MODEL, ts: new Date().toISOString() }));

      const system = `You are ${agent}, a helpful, upbeat AI influencer. Keep it concise.`;
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
              { role: "user", content: message }
            ]
          })
        });

        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(()=>"(no body)");
          controller.enqueue(sse({ type:"delta", content: `OpenAI error: ${resp.status} ${text}\n` }));
          controller.enqueue(sse({ type:"done" }));
          controller.close();
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream:true });

          // OpenAI SSE frames are separated by \n\n and each line starts with "data: "
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!; // last partial (or empty)

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();

            if (data === "[DONE]") { // finish
              controller.enqueue(sse({ type:"done" }));
              controller.close();
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(sse({ type:"delta", content: delta }));
            } catch (_err) {
              // Non-JSON control lines; ignore
            }
          }
        }

        // If the stream ended without a [DONE], gracefully close
        controller.enqueue(sse({ type:"done" }));
        controller.close();
      } catch (err) {
        controller.enqueue(sse({ type:"delta", content: `Edge exception: ${String(err)}\n` }));
        controller.enqueue(sse({ type:"done" }));
        controller.close();
      }
    }
  });

  return new Response(body, { headers, status: 200 });
};
