// netlify/functions/chat.js
// CommonJS (your package.json has "type": "commonjs")

// Node 18+ has global.fetch; keep a fallback for older envs
let _fetch = global.fetch;
if (!_fetch) {
  try {
    _fetch = require("node-fetch");
  } catch {
    throw new Error("Fetch is not available. Use Node 18+ or add node-fetch.");
  }
}

/**
 * Simple CORS headers
 */
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-token",
};

/**
 * Utility response builders
 */
const ok = (bodyObj, extra = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders,
    ...extra,
  },
  body: JSON.stringify(bodyObj),
});

const err = (code, bodyObj, extra = {}) => ({
  statusCode: code,
  headers: {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders,
    ...extra,
  },
  body:
    typeof bodyObj === "string" ? JSON.stringify({ error: bodyObj }) : JSON.stringify(bodyObj),
});

/**
 * Decide if a model should omit temperature entirely.
 * gpt-5 behaves like a fixed-temp model on many providers.
 * Add other patterns as needed.
 */
function modelOmitsTemperature(model) {
  if (!model) return false;
  const m = String(model).toLowerCase().trim();
  return m === "gpt-5" || m.startsWith("gpt-5:") || m.startsWith("gpt5");
}

/**
 * Build an upstream payload, conditionally adding `temperature`.
 * - If temperature is provided AND model supports it -> include it
 * - If model is "fixed-temp" (e.g., gpt-5) -> omit it entirely
 */
function buildUpstreamBody({ message, model, temperature, stream }) {
  const payload = {
    message,
    model,
    stream: !!stream,
  };

  const supportsTemp = !modelOmitsTemperature(model);
  if (supportsTemp && typeof temperature === "number" && Number.isFinite(temperature)) {
    payload.temperature = temperature;
  }

  return payload;
}

/**
 * Resolve auth header:
 * - Prefer incoming Authorization
 * - Else X-Client-Token -> Authorization: Bearer <token>
 * - Else use OPENAI_API_KEY (or whatever your upstream expects)
 */
function resolveAuthHeader(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization;
  if (auth) return { Authorization: auth };

  const xClient = h["x-client-token"] || h["X-Client-Token"];
  if (xClient) return { Authorization: `Bearer ${xClient}` };

  if (process.env.OPENAI_API_KEY) return { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };

  // No auth; upstream might not need it
  return {};
}

/**
 * Determine upstream URL
 * - Prefer env var UPSTREAM_CHAT_URL
 * - Otherwise default to OpenAI Chat Completions-like endpoint (adjust if needed)
 */
function getUpstreamUrl() {
  const envUrl = process.env.UPSTREAM_CHAT_URL || process.env.CHAT_UPSTREAM;
  if (envUrl) return envUrl;

  // Fallback (adjust for your infra). This prevents accidental recursion to this same function.
  return "https://api.openai.com/v1/chat/completions";
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { ...corsHeaders },
      body: "",
    };
  }

  // Health check
  if (event.httpMethod === "GET") {
    return ok({
      ok: true,
      service: "keilani-chat",
      method: "GET",
      time: new Date().toISOString(),
    });
  }

  if (event.httpMethod !== "POST") {
    return err(405, "Method Not Allowed");
  }

  // Parse input
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return err(400, "Invalid JSON body");
  }

  const {
    message,
    model = "gpt-5",
    temperature, // optional
    stream = true,
  } = body;

  if (!message || typeof message !== "string") {
    return err(400, "Missing 'message' (string) in request body.");
  }

  // Build upstream payload with conditional temperature
  const upstreamBody = buildUpstreamBody({ message, model, temperature, stream });

  // Prepare headers
  const authHeader = resolveAuthHeader(event);
  const headers = {
    "content-type": "application/json",
    ...authHeader,
  };

  const upstreamUrl = getUpstreamUrl();

  // Proxy upstream
  let resp;
  try {
    resp = await _fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    return err(502, { error: "Upstream network error", detail: e?.message || String(e) });
  }

  // If upstream failed, bubble up details
  if (!resp.ok) {
    const detailText = await safeReadText(resp);
    return err(resp.status, { error: "Upstream error", detail: detailText });
  }

  // Stream or JSON passthrough
  const contentType = resp.headers.get("content-type") || "";

  // SSE passthrough
  if (contentType.includes("text/event-stream")) {
    const text = await resp.text();
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body: text,
    };
  }

  // JSON passthrough
  if (contentType.includes("application/json")) {
    const json = await resp.json();
    return ok(json);
  }

  // Fallback: return raw text
  const raw = await resp.text();
  return {
    statusCode: 200,
    headers: { ...corsHeaders, "content-type": contentType || "text/plain; charset=utf-8" },
    body: raw,
  };
};

/**
 * Helper: safely read text from response
 */
async function safeReadText(resp) {
  try {
    return await resp.text();
  } catch {
    return "<unable to read upstream body>";
  }
}
