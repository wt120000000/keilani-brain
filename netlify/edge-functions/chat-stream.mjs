// netlify/edge-functions/chat-stream.mjs
export default async function handler(req) {
  // --- CORS allowlist ---
  const ALLOW_ORIGINS = new Set([
    "https://api.keilani.ai",
    "https://keilani-brain.netlify.app",
    "http://localhost:8888",
  ]);
  const origin = req.headers.get("origin") || "";
  const isAllowed = ALLOW_ORIGINS.has(origin);

  const baseHeaders = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-Request-Id",
    "Access-Control-Allow-Credentials": "false",
  };

  const sseHeaders = {
    ...baseHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": isAllowed ? origin : "null",
  };

  if (req.method === "OPTIONS") {
    if (!isAllowed) {
      return new Response("Forbidden", {
        status: 403,
        headers: { ...baseHeaders, "Access-Control-Allow-Origin": "null" },
      });
    }
    return new Response("", {
      status: 204,
      headers: { ...baseHeaders, "Access-Control-Allow-Origin": origin },
    });
  }

  if (!isAllowed) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: "CORS: origin not allowed" })}\n\n`,
      { status: 200, headers: { ...sseHeaders, "Access-Control-Allow-Origin": "null" } }
    );
  }

  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const TEMP  = Number(Deno.env.get("OPENAI_TEMPERATURE") || "0.7");
  const MAX   = Number(Deno.env.get("OPENAI_MAX_OUTPUT_TOKENS") || "512");

  if (!OPENAI_API_KEY) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: "OPENAI_API_KEY missing" })}\n\n`,
      { status: 200, headers: sseHeaders }
    );
  }

  // Accept either {messages:[...]} or {message:"..."}
  let message = "Say hi in one sentence.";
  let convo = null;
  try {
    const b = await req.json();
    if (Array.isArray(b?.messages)) convo = b.messages;
    if (typeof b?.message === "string") message = b.message;
  } catch {}

  const payload = {
    model: MODEL,
    stream: true,
    temperature: TEMP,
    max_completion_tokens: MAX,
    messages:
      convo ??
      [
        { role: "system", content: "You are Keilani: concise, flirty-fun, helpful." },
        { role: "user", content: message },
      ],
  };

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const write = (s) => writer.write(enc.encode(s));
  const send = (event, data = "") =>
    write(data ? `event: ${event}\ndata: ${data}\n\n` : `event: ${event}\n\n`);

  const ping = setInterval(() => write("event: ping\n\n").catch(() => {}), 15000);

  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      await send("error", JSON.stringify({ status: upstream.status, text }));
      await writer.close();
      clearInterval(ping);
      return new Response(readable, { status: 200, headers: sseHeaders });
    }

    await send("open");

    const dec = new TextDecoder();
    const reader = upstream.body.getReader();
    let buf = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });

      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);

        for (const line of frame.split("\n")) {
          const ln = line.trim();
          if (!ln.startsWith("data:")) continue;
          const payload = ln.slice(5).trim();
          if (payload === "[DONE]") {
            await send("done");
            await writer.close();
            clearInterval(ping);
            return new Response(readable, { status: 200, headers: sseHeaders });
          }
          try {
            const j = JSON.parse(payload);
            const delta = j?.choices?.[0]?.delta?.content || "";
            if (delta) await send("delta", JSON.stringify({ text: delta }));
          } catch {
            await send("error", JSON.stringify({ error: "upstream_parse_error" }));
          }
        }
      }
    }

    await send("done");
    await writer.close();
    clearInterval(ping);
    return new Response(readable, { status: 200, headers: sseHeaders });
  } catch (err) {
    await send("error", JSON.stringify({ error: String(err) }));
    await writer.close();
    clearInterval(ping);
    return new Response(readable, { status: 200, headers: sseHeaders });
  }
}
