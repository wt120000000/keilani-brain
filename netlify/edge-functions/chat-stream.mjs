// netlify/edge-functions/chat-stream.mjs
// Edge runtime (Deno). No Node/Process. Read env via Deno.env.get when allowed.
export default async function handler(req) {
  const sseHeaders = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        ...sseHeaders,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    let message = "Say hi in 1 sentence.";
    try {
      const body = await req.json();
      if (body && typeof body.message === "string") message = body.message;
    } catch (_) {}

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY"); // ← works when whitelisted in netlify.toml
    if (!OPENAI_API_KEY) {
      return new Response(`event: error\ndata: ${JSON.stringify({ error: "OPENAI_API_KEY missing" })}\n\n`, {
        status: 200,
        headers: sseHeaders,
      });
    }

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: "You are Keilani: concise, flirty-fun, helpful." },
          { role: "user", content: message },
        ],
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return new Response(
        `event: error\ndata: ${JSON.stringify({ status: upstream.status, text })}\n\n`,
        { status: 200, headers: sseHeaders }
      );
    }

    // Pipe OpenAI SSE through from the edge (native streaming)
    return new Response(upstream.body, { status: 200, headers: sseHeaders });
  } catch (err) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`,
      { status: 200, headers: sseHeaders }
    );
  }
}
