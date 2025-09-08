// netlify/edge-functions/chat-stream.mjs
export default async function handler(req) {
  // --- CORS allowlist (edit to taste) ---
  const ALLOW_ORIGINS = new Set([
    "https://api.keilani.ai",                // prod
    "https://keilani-brain.netlify.app",     // prod site hostname
    "http://localhost:8888",                 // local dev (netlify dev)
  ]);
  const origin = req.headers.get("origin") || "";
  const isAllowed = ALLOW_ORIGINS.has(origin);

  const baseHeaders = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Request-Id",
    // If you need cookies/auth across origins, set Allow-Credentials:true and handle carefully.
    "Access-Control-Allow-Credentials": "false",
  };

  const sseHeaders = {
    ...baseHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": isAllowed ? origin : "null",
  };

  // --- Preflight ---
  if (req.method === "OPTIONS") {
    if (!isAllowed) {
      return new Response("Forbidden", { status: 403, headers: { ...baseHeaders, "Access-Control-Allow-Origin": "null" } });
    }
    return new Response("", { status: 204, headers: { ...baseHeaders, "Access-Control-Allow-Origin": origin } });
  }

  if (!isAllowed) {
    return new Response(`event: error\ndata: ${JSON.stringify({ error: "CORS: origin not allowed" })}\n\n`, {
      status: 200,
      headers: { ...sseHeaders, "Access-Control-Allow-Origin": "null" },
    });
  }

  try {
    // Accept either {messages:[...]} or {message:"..."} for compatibility
    let message = "Say hi in 1 sentence.";
    let convo = null;
    try {
      const body = await req.json();
      if (Array.isArray(body?.messages)) convo = body.messages;
      if (typeof body?.message === "string") message = body.message;
    } catch (_) {}

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      return new Response(`event: error\ndata: ${JSON.stringify({ error: "OPENAI_API_KEY missing" })}\n\n`, {
        status: 200,
        headers: sseHeaders,
      });
    }

    const payload = {
      model: "gpt-4o-mini",
      stream: true,
      messages: convo ?? [
        { role: "system", content: "You are Keilani: concise, flirty-fun, helpful." },
        { role: "user", content: message },
      ],
    };

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return new Response(
        `event: error\ndata: ${JSON.stringify({ status: upstream.status, text })}\n\n`,
        { status: 200, headers: sseHeaders }
      );
    }

    // Native streaming from Edge
    return new Response(upstream.body, { status: 200, headers: sseHeaders });
  } catch (err) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`,
      { status: 200, headers: sseHeaders }
    );
  }
}
