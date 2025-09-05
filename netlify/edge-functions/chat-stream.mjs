// netlify/edge-functions/chat-stream.mjs
// SSE endpoint that streams OpenAI tokens. Use when you want token-by-token playback (e.g., D-ID lip sync).

export default async function handler(request, context) {
  const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
  const DEFAULT_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  if (!OPENAI_KEY) return new Response("openai_key_missing", { status: 500 });

  // CORS
  const origin = request.headers.get("origin") || "";
  const allowlist = (Deno.env.get("CORS_ALLOWED_ORIGINS") || "").split(/[,\s]+/).filter(Boolean);
  const allowOrigin = allowlist.includes(origin) ? origin : (allowlist[0] || "*");
  const baseHeaders = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-User-Id",
    "Cache-Control": "no-cache",
    "Content-Type": "text/event-stream; charset=utf-8",
    "Connection": "keep-alive"
  };
  if (request.method === "OPTIONS") return new Response("", { status: 200, headers: baseHeaders });
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405, headers: baseHeaders });

  const userId = request.headers.get("x-user-id") || "";
  if (!userId) return new Response("unauthorized", { status: 401, headers: baseHeaders });

  let body;
  try { body = await request.json(); } catch { return new Response("invalid_json", { status: 400, headers: baseHeaders }); }

  const role  = String(body.role || "COMPANION").toUpperCase();
  const model = String(body.model || DEFAULT_MODEL);

  const system = buildSystem(role);
  const messages = Array.isArray(body.messages)
    ? [{ role: "system", content: system }, ...body.messages]
    : [{ role: "system", content: system }, { role: "user", content: String(body.message || "").trim() }];

  // OpenAI streaming call
  const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
  const isG5 = model.startsWith("gpt-5");
  const streamPayload = {
    model,
   temperature: Math.min(Math.max(Number(body.temperature ?? 0.8), 0), 1),
    stream: true,
    messages,
    ...(isG5
      ? { max_completion_tokens: Number(body.max_tokens ?? 400) }
      : { max_tokens: Number(body.max_tokens ?? 400) })
};

body: JSON.stringify(streamPayload)

    
  });

  if (!oaRes.ok || !oaRes.body) {
    const text = await oaRes.text().catch(() => "");
    return new Response(`openai_error\n${text}`, { status: oaRes.status, headers: baseHeaders });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // helper to send SSE frame
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
      };

      // forward OpenAI event stream to SSE
      const reader = oaRes.body.getReader();
      let acc = "";
      try {
        send("open", "{}");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += new TextDecoder().decode(value);
          const chunks = acc.split("\n\n");
          acc = chunks.pop() || ""; // last partial
          for (const chunk of chunks) {
            const line = chunk.trim();
            if (!line) continue;
            // OpenAI sends "data: {json}" lines
            const dataLine = line.startsWith("data:") ? line.slice(5).trim() : line;
            if (dataLine === "[DONE]") {
              send("done", {});
              controller.close();
              return;
            }
            try {
              const json = JSON.parse(dataLine);
              const delta = json?.choices?.[0]?.delta?.content || "";
              if (delta) send("token", delta);
            } catch (_) { /* ignore parse errors */ }
          }
        }
        send("done", {});
        controller.close();
      } catch (err) {
        send("error", { message: String(err?.message || err) });
        controller.error(err);
      }
    }
  });

  return new Response(stream, { headers: baseHeaders });
}

function buildSystem(role) {
  const byRole = {
    COMPANION: "You are Keilani: playful, kind, supportive. Keep replies short and warm.",
    MENTOR:    "You are Keilani: practical, compassionate coach. No medical/legal advice.",
    GAMER:     "You are Keilani: hype gamer friend and coach. Be energetic and tactical.",
    CREATOR:   "You are Keilani: creative strategist; suggest hooks, formats, and trends.",
    POLYGLOT:  "You are Keilani: language buddy; be encouraging and correct gently.",
    CUSTOM:    "You are Keilani: use the user's saved preferences to mirror their style."
  };
  return byRole[role] || byRole.COMPANION;
}
