// Diagnostic SSE relay for Netlify Edge
// - Immediate telemetry frame
// - 500ms heartbeats so clients see sustained streaming
// - Optional OpenAI relay (chat.completions stream) when OPENAI_API_KEY is set

const MODEL   = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

const te = new TextEncoder();
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function parsePayload(reqUrl, method, bodyText, contentType) {
  const url = new URL(reqUrl);
  // 1) Querystring (GET probe)
  const qsMsg = url.searchParams.get("message");
  const qsUserId = url.searchParams.get("userId");
  const qsAgent = url.searchParams.get("agent") || "keilani";
  if (qsMsg && qsUserId) return { message: qsMsg, userId: qsUserId, agent: qsAgent };

  // 2) JSON body
  if (method === "POST" && contentType?.includes("application/json")) {
    try {
      const json = JSON.parse(bodyText || "{}");
      if (json?.message && json?.userId) {
        return { message: json.message, userId: json.userId, agent: json.agent || "keilani" };
      }
    } catch {}
  }

  // 3) Form body
  if (method === "POST" && contentType?.includes("application/x-www-form-urlencoded")) {
    const p = new URLSearchParams(bodyText || "");
    const message = p.get("message");
    const userId  = p.get("userId");
    const agent   = p.get("agent") || "keilani";
    if (message && userId) return { message, userId, agent };
  }

  return null;
}

export default async (request, context) => {
  // Only POST/GET
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { "content-type": "application/json" }
    });
  }

  // Read body once (Edge streams don't allow multiple reads)
  let rawBody = "";
  let contentType = request.headers.get("content-type") || "";
  if (request.method === "POST") {
    try { rawBody = await request.text(); } catch { rawBody = ""; }
  }

  const parsed = parsePayload(request.url, request.method, rawBody, contentType);
  if (!parsed) {
    return new Response(JSON.stringify({
      error: "missing_fields",
      detail: "Provide { message, userId } via JSON, form, or query",
      received: { contentType, bodyPreview: rawBody?.slice?.(0, 256) ?? "" }
    }), { status: 400, headers: { "content-type": "application/json" }});
  }
  const { message, userId, agent } = parsed;

  // SSE response headers
  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "keep-alive": "timeout=60",
    "x-robots-tag": "noindex"
  });

  const body = new ReadableStream({
    async start(controller) {
      const push = (obj) => controller.enqueue(te.encode(sse(obj)));

      // Immediate ack so clients stop “spinning”
      push({ type: "telemetry", model: MODEL, agent, ts: new Date().toISOString() });

      // Heartbeat every 500ms while we do work (cleared on close)
      const hb = setInterval(() => push({ type: "heartbeat", ts: Date.now() }), 500);

      // If no key, just send a friendly demo message and close
      if (!API_KEY) {
        push({ type: "delta", content: `Hi ${userId}! (no OPENAI_API_KEY set) ` });
        push({ type: "delta", content: `Echo: ${message}\n` });
        clearInterval(hb);
        push({ type: "done" });
        controller.close();
        return;
      }

      try {
        // Kick off OpenAI stream (chat.completions)
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
              { role: "system", content: `You are ${agent}, a helpful, upbeat AI influencer. Keep it concise.` },
              { role: "user",   content: message }
            ]
          })
        });

        if (!resp.ok || !resp.body) {
          const txt = await resp.text().catch(()=>"");
          push({ type: "delta", content: `OpenAI error: ${resp.status} ${txt}\n` });
          clearInterval(hb);
          push({ type: "done" });
          controller.close();
          return;
        }

        // Relay OpenAI SSE frames
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();

            if (data === "[DONE]") {
              clearInterval(hb);
              push({ type: "done" });
              controller.close();
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) push({ type: "delta", content: delta });
            } catch {
              // ignore control lines
            }
          }
        }

        // If the OpenAI stream ended silently, end ours gracefully
        clearInterval(hb);
        push({ type: "done" });
        controller.close();
      } catch (err) {
        clearInterval(hb);
        push({ type: "delta", content: `Edge exception: ${String(err)}\n` });
        push({ type: "done" });
        controller.close();
      }
    }
  });

  return new Response(body, { status: 200, headers });
};
