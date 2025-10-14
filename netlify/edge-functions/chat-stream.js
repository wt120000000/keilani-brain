// netlify/edge-functions/chat-stream.js
// Edge runtime (Deno). Streams OpenAI Chat Completions as SSE without any HTTP/2-invalid headers.

const MODEL   = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const API_KEY = Deno.env.get("OPENAI_API_KEY")     || "";

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function parsePayload(req) {
  const url = new URL(req.url);

  // Defaults (query can pre-fill)
  let message = url.searchParams.get("message") ?? undefined;
  let userId  = url.searchParams.get("userId")  ?? undefined;
  let agent   = url.searchParams.get("agent")   ?? "keilani";

  // POST bodies (json | form | raw)
  if (req.method === "POST") {
    const ct = (req.headers.get("content-type") || "").toLowerCase();

    if (ct.includes("application/json")) {
      try {
        const j = await req.json();
        if (j && typeof j === "object") {
          message ??= j.message;
          userId  ??= j.userId;
          agent   =  j.agent ?? agent;
        }
      } catch {}
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      try {
        const form = await req.formData();
        message ??= form.get("message") ?? undefined;
        userId  ??= form.get("userId")  ?? undefined;
        agent    = (form.get("agent")  ?? agent);
      } catch {}
    } else {
      // Try best-effort text->JSON
      try {
        const text = await req.text();
        if (text) {
          const j = JSON.parse(text);
          message ??= j.message;
          userId  ??= j.userId;
          agent   =  j.agent ?? agent;
        }
      } catch {}
    }
  }

  return { message, userId, agent };
}

export default async (request, context) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  // IMPORTANT: no "connection" header (forbidden in HTTP/2)
  const headers = new Headers({
    "content-type":  "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no" // hint proxies to not buffer
  });

  const { message, userId, agent } = await parsePayload(request);

  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({
        type: "telemetry",
        ts: new Date().toISOString(),
        model: MODEL
      }));

      if (!message || !userId) {
        controller.enqueue(sse({
          type: "error",
          code: "missing_fields",
          detail: "Provide { message, userId }"
        }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
        return;
      }

      // No API key? Keep UX moving with a friendly echo.
      if (!API_KEY) {
        controller.enqueue(sse({
          type: "delta",
          content: `(OPENAI_API_KEY not set) Echo: ${message}\n`
        }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
        return;
      }

      try {
        const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "authorization": `Bearer ${API_KEY}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: MODEL,
            stream: true,
            messages: [
              { role: "system", content: `You are ${agent}, a concise, upbeat AI.` },
              { role: "user",   content: message }
            ]
          })
        });

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => "");
          controller.enqueue(sse({
            type: "error",
            code: "upstream",
            status: upstream.status,
            detail: text.slice(0, 500)
          }));
          controller.enqueue(sse({ type: "done" }));
          controller.close();
          return;
        }

        const reader  = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer    = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.trim();
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
              // ignore non-JSON control lines
            }
          }
        }

        controller.enqueue(sse({ type: "done" }));
        controller.close();
      } catch (err) {
        controller.enqueue(sse({
          type: "error",
          code: "exception",
          detail: String(err)
        }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      }
    }
  });

  return new Response(body, { status: 200, headers });
};
