// Edge Function: /api/chat-stream
// Streams OpenAI Chat Completions as Server-Sent Events.

const MODEL  = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const APIKEY = Deno.env.get("OPENAI_API_KEY")    || "";

// Small helper to format an SSE frame.
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Parse the incoming request payload from JSON, form, or query.
async function parsePayload(req) {
  let message, userId, agent;

  // Try JSON
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await req.json();
      message = j?.message;
      userId  = j?.userId;
      agent   = j?.agent;
    }
  } catch (_) {}

  // Try form-encoded
  if (!message || !userId) {
    try {
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const f = await req.formData();
        message = message ?? f.get("message");
        userId  = userId  ?? f.get("userId");
        agent   = agent   ?? f.get("agent");
      }
    } catch (_) {}
  }

  // Try query string
  if (!message || !userId) {
    const url = new URL(req.url);
    message = message ?? url.searchParams.get("message");
    userId  = userId  ?? url.searchParams.get("userId");
    agent   = agent   ?? url.searchParams.get("agent");
  }

  // Allow “digits only” bodies from some CLI (debug only)
  if (!message || !userId) {
    try {
      const raw = await req.text();
      if (/^\d+(\r?\n\d+)*\r?\n?$/.test(raw)) {
        const bytes = raw.trim().split(/\s+/).map(n => Number(n));
        const str   = new TextDecoder().decode(new Uint8Array(bytes));
        const j     = JSON.parse(str);
        message = j?.message ?? message;
        userId  = j?.userId  ?? userId;
        agent   = j?.agent   ?? agent;
      }
    } catch (_) {}
  }

  return { message, userId, agent: agent || "keilani" };
}

export default async (request, context) => {
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  const { message, userId, agent } = await parsePayload(request);

  if (!message || !userId) {
    return new Response(
      JSON.stringify({ error: "missing_fields", detail: "Provide { message, userId }" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  // NOTE: Do NOT include "Connection" on HTTP/2 responses.
  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform"
    // "connection": "keep-alive"  <-- illegal on HTTP/2; omit it.
  });

  // No key? Send a friendly fake stream so the UI still moves.
  if (!APIKEY) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));
        controller.enqueue(sse({ type: "delta", content: "Hi! (no OPENAI_API_KEY set)\n" }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      }
    });
    return new Response(body, { headers, status: 200 });
  }

  // Relay OpenAI stream to client SSE
  const body = new ReadableStream({
    async start(controller) {
      // Early ack so the client shows "connected".
      controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString() }));

      // Keepalive pings (SSE comments) so intermediaries don’t idle-timeout.
      const ka = setInterval(() => {
        try { controller.enqueue(`:keepalive ${Date.now()}\n\n`); } catch {}
      }, 15000);

      const system = `You are ${agent}, a helpful, upbeat AI influencer. Keep it concise.`;

      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "authorization": `Bearer ${APIKEY}`,
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
          const text = await resp.text().catch(() => "(no body)");
          controller.enqueue(sse({ type: "delta", content: `OpenAI error: ${resp.status} ${text}\n` }));
          controller.enqueue(sse({ type: "done" }));
          controller.close();
          clearInterval(ka);
          return;
        }

        const reader  = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Split OpenAI SSE frames by double newline
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? ""; // leftover partial

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              controller.enqueue(sse({ type: "done" }));
              controller.close();
              clearInterval(ka);
              return;
            }
            try {
              const json  = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(sse({ type: "delta", content: delta }));
            } catch {
              // ignore control frames/non-JSON
            }
          }
        }

        // If upstream ended without explicit [DONE]
        controller.enqueue(sse({ type: "done" }));
        controller.close();
        clearInterval(ka);
      } catch (err) {
        controller.enqueue(sse({ type: "delta", content: `Edge exception: ${String(err)}\n` }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
        clearInterval(ka);
      }
    }
  });

  return new Response(body, { headers, status: 200 });
};
