// netlify/edge-functions/chat-stream.mjs
// SSE proxy to OpenAI with instant return, microtask first-byte, and keepalives

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

  // --- Preflight
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
    const msg = `event: error\ndata: ${JSON.stringify({
      error: "CORS: origin not allowed",
    })}\n\n`;
    return new Response(msg, { status: 200, headers: sseHeaders });
  }

  // ---- Observability
  const rid =
    req.headers.get("x-request-id") ||
    crypto.randomUUID?.() ||
    String(Date.now());
  const ua = req.headers.get("user-agent") || "";
  const ip = (req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for") ||
    "")
    .split(",")[0]
    .trim();

  // ---- Env
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const MAX_OUT = Number(
    Deno.env.get("OPENAI_MAX_COMPLETION_TOKENS") || "512",
  );
  const RAW_TEMP = Deno.env.get("OPENAI_TEMPERATURE");
  const TEMPERATURE = RAW_TEMP === undefined ? undefined : Number(RAW_TEMP);

  // Prepare request body (don’t block the response return)
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

  const payload = {
    model: MODEL,
    stream: true,
    max_completion_tokens: MAX_OUT, // correct param for newer models
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

  console.log("[edge/chat-stream] start", {
    rid,
    ip,
    ua,
    model: MODEL,
    sz: approxSize,
  });

  // Create stream and return IMMEDIATELY – do NOT await any writes before return
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  // Schedule work on microtask queue so the function returns first
  queueMicrotask(async () => {
    let pingInterval;
    try {
      // send an "open" frame ASAP (but after return)
      try {
        await writer.write(
          enc.encode(`event: open\ndata: {"rid":"${rid}"}\n\n`),
        );
      } catch (e) {
        console.error("[edge/chat-stream] open write fail", rid, String(e));
        try { await writer.close(); } catch {}
        return;
      }

      // start keepalives
      pingInterval = setInterval(async () => {
        try {
          await writer.write(enc.encode(`event: ping\ndata: 1\n\n`));
        } catch {
          clearInterval(pingInterval);
        }
      }, 15000);

      // upstream fetch with abort watchdog
      const ac = new AbortController();
      const watchdog = setTimeout(() => ac.abort("watchdog"), 120000); // 120s ceiling

      let upstream;
      try {
        upstream = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(payload),
            signal: ac.signal,
          },
        );
      } catch (err) {
        console.error("[edge/chat-stream] upstream fetch fail", rid, String(err));
        try {
          await writer.write(
            enc.encode(
              `event: error\ndata: ${JSON.stringify({
                error: "Upstream fetch failed",
              })}\n\n`,
            ),
          );
        } catch {}
        clearInterval(pingInterval);
        clearTimeout(watchdog);
        try { await writer.close(); } catch {}
        return;
      }

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        console.error("[edge/chat-stream] upstream_error", {
          rid,
          status: upstream.status,
          text: text?.slice(0, 300),
        });
        try {
          await writer.write(
            enc.encode(
              `event: error\ndata: ${JSON.stringify({
                status: upstream.status,
                text,
              })}\n\n`,
            ),
          );
        } catch {}
        clearInterval(pingInterval);
        clearTimeout(watchdog);
        try { await writer.close(); } catch {}
        return;
      }

      // pump bytes from OpenAI to client
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();

      async function pump() {
        const { value, done } = await reader.read();
        if (done) {
          clearInterval(pingInterval);
          clearTimeout(watchdog);
          try {
            await writer.write(enc.encode(`event: done\ndata: {}\n\n`));
          } catch {}
          try { await writer.close(); } catch {}
          console.log("[edge/chat-stream] done", { rid });
          return;
        }
        const chunk = dec.decode(value);
        try {
          await writer.write(enc.encode(chunk));
        } catch (err) {
          console.error("[edge/chat-stream] client write error", rid, String(err));
          clearInterval(pingInterval);
          clearTimeout(watchdog);
          try { await writer.close(); } catch {}
          return;
        }
        return pump();
      }

      pump().catch(async (err) => {
        console.error("[edge/chat-stream] pump_error", rid, String(err));
        clearInterval(pingInterval);
        clearTimeout(watchdog);
        try {
          await writer.write(
            enc.encode(
              `event: error\ndata: ${JSON.stringify({
                error: "Stream aborted",
              })}\n\n`,
            ),
          );
        } catch {}
        try { await writer.close(); } catch {}
      });
    } catch (err) {
      console.error("[edge/chat-stream] fatal-scheduled", rid, String(err));
      try {
        await writer.write(
          enc.encode(
            `event: error\ndata: ${JSON.stringify({
              error: "Unexpected error",
            })}\n\n`,
          ),
        );
      } catch {}
      try { await writer.close(); } catch {}
      clearInterval(pingInterval);
    }
  });

  // IMPORTANT: return NOW, before any await’ed writes
  return new Response(readable, { status: 200, headers: sseHeaders });
}
