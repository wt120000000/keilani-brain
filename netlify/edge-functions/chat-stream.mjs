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
      `event: error\ndata: ${JSON.stringify({
        error: "CORS: origin not allowed",
      })}\n\n`,
      { status: 200, headers: { ...sseHeaders, "Access-Control-Allow-Origin": "null" } }
    );
  }

  const rid = req.headers.get("x-request-id") ||
              crypto.randomUUID?.() ||
              String(Date.now());

  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const TEMP = Number(Deno.env.get("OPENAI_TEMPERATURE") || "0.7");
  const MAX_COMP = Number(Deno.env.get("OPENAI_MAX_OUTPUT_TOKENS") || "512");

  if (!OPENAI_API_KEY) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: "OPENAI_API_KEY missing" })}\n\n`,
      { status: 200, headers: sseHeaders }
    );
  }

  // Read body (allow {message} or {messages})
  let msg = "Say hi in one sentence.";
  let messages = null;
  try {
    const b = await req.json();
    if (Array.isArray(b?.messages)) messages = b.messages;
    if (typeof b?.message === "string") msg = b.message;
  } catch {}

  const payload = {
    model: MODEL,
    stream: true,
    temperature: TEMP,
    // NOTE: current OpenAI param for output length:
    max_completion_tokens: MAX_COMP,
    messages:
      messages ??
      [
        { role: "system", content: "You are Keilani: concise, flirty-fun, helpful." },
        { role: "user", content: msg },
      ],
  };

  // Create a transform stream to write our own SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const textEncoder = new TextEncoder();

  // small helper to send events
  const send = async (event, data = "") => {
    const body = data ? `event: ${event}\ndata: ${data}\n\n` : `event: ${event}\n\n`;
    await writer.write(textEncoder.encode(body));
  };

  // Keep-alive ping
  const ping = setInterval(() => {
    writer.write(textEncoder.encode("event: ping\n\n")).catch(() => {});
  }, 15000);

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
      return new Response(readable, { headers: sseHeaders, status: 200 });
    }

    // Parse OpenAI SSE and re-emit {text}
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Notify open
    await send("open");

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        // OpenAI chunks are lines like "data: {...}" or "data: [DONE]"
        const lines = chunk.split("\n").map((l) => l.trim());
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();

          if (payload === "[DONE]") {
            await send("done");
            await writer.close();
            clearInterval(ping);
            return new Response(readable, { headers: sseHeaders, status: 200 });
          }

          try {
            const j = JSON.parse(payload);
            const delta = j?.choices?.[0]?.delta?.content || "";
            if (delta) await send("delta", JSON.stringify({ text: delta }));
          } catch (e) {
            // If parsing fails, forward as error but keep stream alive
            await send("error", JSON.stringify({ error: "upstream_parse_error" }));
          }
        }
      }
    }

    // fallback close
    await send("done");
    await writer.close();
    clearInterval(ping);
    return new Response(readable, { headers: sseHeaders, status: 200 });
  } catch (err) {
    await send("error", JSON.stringify({ error: String(err) }));
    await writer.close();
    clearInterval(ping);
    return new Response(readable, { headers: sseHeaders, status: 200 });
  }
}
