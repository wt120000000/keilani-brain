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
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Request-Id",
    "Access-Control-Allow-Credentials": "false",
  };

  const sseHeaders = {
    ...baseHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": isAllowed ? origin : "null",
  };

  // ---- Observability bits ----
  const rid = req.headers.get("x-request-id") || crypto.randomUUID?.() || String(Date.now());
  const ua  = req.headers.get("user-agent") || "";
  const ip  = (req.headers.get("x-nf-client-connection-ip")
            || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();

  // Config via env (safe defaults)
  const MODEL       = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const MAX_OUTPUT  = Number(Deno.env.get("OPENAI_MAX_OUTPUT_TOKENS") || "512");      // cap responses
  const TEMPERATURE = Number(Deno.env.get("OPENAI_TEMPERATURE") || "0.7");

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

  const t0 = Date.now();
  try {
    // Accept either {messages:[...]} or {message:"..."}
    let message = "Say hi in 1 sentence.";
    let convo = null;
    try {
      const body = await req.json();
      if (Array.isArray(body?.messages)) convo = body.messages;
      if (typeof body?.message === "string") message = body.message;
    } catch (_) {}

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      console.error("[chat-stream] missing OPENAI_API_KEY", { rid });
      return new Response(`event: error\ndata: ${JSON.stringify({ error: "OPENAI_API_KEY missing" })}\n\n`, {
        status: 200,
        headers: sseHeaders,
      });
    }

    // Simple guardrail: limit oversized payloads (prevents huge bills / 413s)
    const payload = {
      model: MODEL,
      stream: true,
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT,
      messages: convo ?? [
        { role: "system", content: "You are Keilani: concise, flirty-fun, helpful." },
        { role: "user", content: message }
      ],
    };
    const approxSize = new TextEncoder().encode(JSON.stringify(payload)).length;
    const MAX_BYTES = 200_000; // ~200 KB safety cap for request
    if (approxSize > MAX_BYTES) {
      console.warn("[chat-stream] payload_too_large", { rid, approxSize });
      return new Response(
        `event: error\ndata: ${JSON.stringify({ error: "Prompt too large. Try shortening your message." })}\n\n`,
        { status: 200, headers: sseHeaders }
      );
    }

    console.log("[chat-stream] start", { rid, ip, ua, origin, model: MODEL, size: approxSize });

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
      console.error("[chat-stream] upstream_error", { rid, status: upstream.status, text: text?.slice(0, 300) });
      return new Response(
        `event: error\ndata: ${JSON.stringify({ status: upstream.status, text })}\n\n`,
        { status: 200, headers: sseHeaders }
      );
    }

    // Stream through
    const resp = new Response(upstream.body, { status: 200, headers: sseHeaders });

    // Log completion when stream finishes
    resp.body?.tee?.(); // not strictly needed; logging below is best-effort after await
    const doneLog = () => console.log("[chat-stream] done", { rid, ms: Date.now() - t0 });
    // Deno doesn't expose onfinish; we log after return as best-effort
    setTimeout(doneLog, 0);

    return resp;
  } catch (err) {
    console.error("[chat-stream] fatal", { rid, err: String(err) });
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: "Unexpected error" })}\n\n`,
      { status: 200, headers: sseHeaders }
    );
  }
}
