// netlify/edge-functions/chat-stream.mjs
// SSE chat streaming with keepalive + robust error frames

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
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-Request-Id",
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
    // Send an SSE error frame so the client can show something friendly
    const msg = `event: error\ndata: ${JSON.stringify({
      error: "CORS: origin not allowed",
    })}\n\n`;
    return new Response(msg, { status: 200, headers: sseHeaders });
  }

  // ---- Observability
  const rid = req.headers.get("x-request-id") ||
    crypto.randomUUID?.() ||
    String(Date.now());
  const ua = req.headers.get("user-agent") || "";
  const ip = (req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for") ||
    "").split(",")[0].trim();

  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const MAX_OUT = Number(
    Deno.env.get("OPENAI_MAX_COMPLETION_TOKENS") || "512",
  );
  // Some models only accept temperature = 1 (default).
  // Leave undefined unless explicitly set.
  const RAW_TEMP = Deno.env.get("OPENAI_TEMPERATURE");
  const TEMPERATURE = RAW_TEMP === undefined ? undefined : Number(RAW_TEMP);

  try {
    let message = "Say hi in 1 sentence.";
    let convo = null;
    try {
      const body = await req.json();
      if (Array.isArray(body?.messages)) convo = body.messages;
      if (typeof body?.message === "string") message = body.message;
    } catch (_) {}

    if (!OPENAI_API_KEY) {
      const msg = `event: error\ndata: ${JSON.stringify({
        error: "OPENAI_API_KEY missing",
      })}\n\n`;
      return new Response(msg, { status: 200, headers: sseHeaders });
    }

    // Build payload (use correct param max_completion_tokens)
    const payload = {
      model: MODEL,
      stream: true,
      max_completion_tokens: MAX_OUT,
      messages:
        convo ??
        [
          { role: "system", content: "You are Keilani: concise, fun, helpful." },
          { role: "user", content: message },
        ],
    };
    if (TEMPERATURE !== undefined) payload.temperature = TEMPERATURE;

    const approxSize = new TextEncoder().encode(JSON.stringify(payload)).length;
    if (approxSize > 200_000) {
      const msg = `event: error\ndata: ${JSON.stringify({
        error: "Prompt too large. Try shortening your message.",
      })}\n\n`;
      return new Response(msg, { status: 200, headers: sseHeaders });
    }

    console.log("[chat-stream] start", {
      rid,
      ip,
      ua,
      origin,
      model: MODEL,
      sz: approxSize,
    });

    // Create a stream we control so we can send keepalives
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    // Immediately send an "open" frame so the CDN sees bytes
    await writer.write(enc.encode(`event: open\ndata: {"rid":"${rid}"}\n\n`));

    // Keep-alive pings while we wait for upstream / or during long responses
    let firstByteSeen = false;
    const pingInterval = setInterval(async () => {
      try {
        await writer.write(enc.encode(`event: ping\ndata: 1\n\n`));
      } catch (_) {
        clearInterval(pingInterval);
      }
    }, 15000);

    // Proxy upstream
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
      console.error("[chat-stream] upstream_error", {
        rid,
        status: upstream.status,
        text: text?.slice(0, 300),
      });
      await writer.write(
        enc.encode(
          `event: error\ndata: ${JSON.stringify({
            status: upstream.status,
            text,
          })}\n\n`,
        ),
      );
      clearInterval(pingInterval);
      await writer.close();
      return new Response(readable, { status: 200, headers: sseHeaders });
    }

    // Read OpenAI stream and forward frames
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();

    async function pump() {
      const { value, done } = await reader.read();
      if (done) {
        clearInterval(pingInterval);
        await writer.write(enc.encode(`event: done\ndata: {}\n\n`));
        await writer.close();
        console.log("[chat-stream] done", { rid });
        return;
      }

      if (!firstByteSeen) firstByteSeen = true;

      const chunk = dec.decode(value);
      // Forward raw to client; the browser client already parses "data:" frames
      await writer.write(enc.encode(chunk));
      return pump();
    }

    // Start pumping
    pump().catch(async (err) => {
      console.error("[chat-stream] pump_error", { rid, err: String(err) });
      clearInterval(pingInterval);
      try {
        await writer.write(
          enc.encode(`event: error\ndata: ${JSON.stringify({
            error: "Stream aborted",
          })}\n\n`),
        );
      } catch {}
      try { await writer.close(); } catch {}
    });

    return new Response(readable, { status: 200, headers: sseHeaders });
  } catch (err) {
    console.error("[chat-stream] fatal", { rid, err: String(err) });
    const msg = `event: error\ndata: ${JSON.stringify({
      error: "Unexpected error",
    })}\n\n`;
    return new Response(msg, { status: 200, headers: sseHeaders });
  }
}
