// netlify/edge-functions/chat-stream.mjs
// Streams OpenAI Chat Completions to the browser via SSE.
// - Uses max_completion_tokens (newer models)
// - Returns NON-200 on upstream errors so the client can fall back
// - CORS allowlist for your domains
// - Temperature: defaults to 1 (many “mini” models only allow 1). We only
//   include the parameter when it’s safe (OPENAI_INCLUDE_TEMPERATURE="1").
//
// ENV:
//   OPENAI_API_KEY                 (required)
//   OPENAI_MODEL                   (default: gpt-4o-mini)
//   OPENAI_MAX_OUTPUT_TOKENS       (default: 512)
//   OPENAI_TEMPERATURE             (default: "1")
//   OPENAI_INCLUDE_TEMPERATURE     (default: "1")  -> include temperature field
//                                                (set to "0" to omit entirely)

export default async function handler(req) {
  // --- CORS allowlist ---
  const ALLOW_ORIGINS = new Set([
    "https://api.keilani.ai",
    "https://keilani-brain.netlify.app",
    "http://localhost:8888",
    "http://localhost:3000",
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
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": isAllowed ? origin : "null",
  };

  // Observability (best-effort)
  const rid =
    req.headers.get("x-request-id") ||
    (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
  const ua = req.headers.get("user-agent") || "";
  const ip = (req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for") ||
    "")
    .split(",")[0]
    .trim();

  // Env & defaults
  const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const MAX_OUTPUT = Number(Deno.env.get("OPENAI_MAX_OUTPUT_TOKENS") || "512");

  // IMPORTANT: many “mini” models only accept temperature=1.
  // Default to 1, and only include the field if OPENAI_INCLUDE_TEMPERATURE = "1".
  const TEMPERATURE_RAW = Deno.env.get("OPENAI_TEMPERATURE");
  const TEMPERATURE = Number(
    TEMPERATURE_RAW == null || TEMPERATURE_RAW === "" ? "1" : TEMPERATURE_RAW
  );
  const INCLUDE_TEMPERATURE =
    (Deno.env.get("OPENAI_INCLUDE_TEMPERATURE") || "1") === "1";

  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

  // --- Preflight ---
  if (req.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        ...baseHeaders,
        "Access-Control-Allow-Origin": isAllowed ? origin : "null",
      },
    });
  }

  if (!isAllowed) {
    // Return a real error (non-200) so the client fallback can engage
    return new Response(
      JSON.stringify({ error: "CORS: origin not allowed", origin }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "null",
          Vary: "Origin",
        },
      }
    );
  }

  if (!OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY missing" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      },
    });
  }

  // Parse body (accept {messages:[...]} or {message:"..."})
  let userMessage = "Say hi in 1 sentence.";
  let messages = null;
  try {
    const body = await req.json();
    if (Array.isArray(body?.messages)) messages = body.messages;
    if (typeof body?.message === "string") userMessage = body.message;
  } catch {
    /* ignore; keep defaults */
  }

  // Build payload
  const payload = {
    model: MODEL,
    stream: true,
    max_completion_tokens: MAX_OUTPUT, // newer models prefer this
    messages:
      messages ??
      [
        { role: "system", content: "You are Keilani: concise, flirty-fun, helpful." },
        { role: "user", content: userMessage },
      ],
  };

  // Include temperature iff allowed (to avoid “only default (1) supported” errors)
  if (INCLUDE_TEMPERATURE) {
    // If a model only supports 1, sending 1 is fine; some models ignore it.
    payload.temperature = TEMPERATURE;
  }

  // Safety cap on request size
  const approxSize = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (approxSize > 200_000) {
    return new Response(
      JSON.stringify({ error: "Prompt too large. Try shortening your message." }),
      {
        status: 413,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
        },
      }
    );
  }

  try {
    console.log("[chat-stream] start", {
      rid,
      ip,
      ua,
      origin,
      model: MODEL,
      size: approxSize,
      include_temperature: INCLUDE_TEMPERATURE,
      temperature: TEMPERATURE,
    });

    const upstream = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      console.error("[chat-stream] upstream_error", {
        rid,
        status: upstream.status,
        text: text?.slice(0, 300),
      });
      return new Response(
        JSON.stringify({
          error: "upstream_error",
          status: upstream.status,
          text,
        }),
        {
          status: upstream.status || 502,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": origin,
            Vary: "Origin",
          },
        }
      );
    }

    // Pass-through SSE stream
    return new Response(upstream.body, {
      status: 200,
      headers: sseHeaders,
    });
  } catch (err) {
    console.error("[chat-stream] fatal", { rid, err: String(err) });
    return new Response(JSON.stringify({ error: "Unexpected error" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      },
    });
  }
}
