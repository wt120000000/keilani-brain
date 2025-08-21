// netlify/functions/chat.mjs
// ESM serverless function for Netlify

// --- helpers ---
const redact = (v) => (v ? `${String(v).slice(0, 4)}…(${String(v).length})` : "MISSING");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// --- handler ---
export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  // Method guard
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ ok: false, error: "Method Not Allowed" }),
    };
  }

  // --- env reads (with Supabase fallback) ---
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
  const SUPABASE_KEY_SOURCE = process.env.SUPABASE_SERVICE_ROLE
    ? "SUPABASE_SERVICE_ROLE"
    : (process.env.SUPABASE_KEY ? "SUPABASE_KEY" : "MISSING");

  // request context (safe)
  console.log("---- /api/chat request ----", {
    method: event.httpMethod,
    query: event.queryStringParameters,
    ctype: event.headers?.["content-type"] || event.headers?.["Content-Type"],
  });

  // env logging (redacted)
  console.log("env check:", {
    OPENAI_API_KEY: redact(OPENAI_API_KEY),
    SUPABASE_URL: SUPABASE_URL ? "SET" : "MISSING",
    SUPABASE_KEY: SUPABASE_KEY ? `${redact(SUPABASE_KEY)} via ${SUPABASE_KEY_SOURCE}` : "MISSING",
    NODE_VERSION: process.env.NODE_VERSION || "unknown",
  });

  // hard requirement for OpenAI
  if (!OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, stage: "env", error: "OPENAI_API_KEY missing" }),
    };
  }

  // parse body
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    console.error("JSON parse error:", e);
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ ok: false, stage: "parse", error: "Invalid JSON body" }),
    };
  }

  // validate inputs
  const { userId = null, message, nocontext } = body;
  if (!message || typeof message !== "string") {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ ok: false, stage: "validate", error: "Missing 'message' (string)" }),
    };
  }

  // warn if Supabase likely needed but missing (non-fatal)
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[warn] Supabase env incomplete — continuing (DB ops are disabled for this request).");
  }

  // --- call OpenAI (chat completions) ---
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are Keilani—warm, upbeat, concise, and helpful." },
          // Optionally use nocontext flag in the future to skip retrieval
          { role: "user", content: message },
        ],
        temperature: 0.7,
      }),
    });

    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // keep raw text for logging if JSON parse fails
    }

    console.log("openai.status:", r.status);
    if (r.status >= 400) {
      console.error("openai.errorBody:", text);
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({
          ok: false,
          stage: "chat",
          error: `OpenAI HTTP ${r.status}`,
          upstream: text.slice(0, 400),
        }),
      };
    }

    const reply = json?.choices?.[0]?.message?.content ?? "(no content)";
    const response = {
      ok: true,
      userId,
      reply,
      meta: { model: json?.model, created: json?.created, nocontext: !!nocontext },
    };

    console.log("response:", response);
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(response),
    };
  } catch (err) {
    console.error("chat handler fatal:", err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        ok: false,
        stage: "chat",
        error: err?.message || "unknown error",
      }),
    };
  }
};
