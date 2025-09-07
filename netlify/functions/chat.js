/**
 * Netlify Function: /api/chat → /.netlify/functions/chat
 * Uses OpenAI Responses API (model + input).
 * - POST body: { message?: string, model?: string, stream?: boolean, ... }
 * - CORS preflight supported
 * - Simple shared-key auth with X-Client-Key against env PUBLIC_API_KEY
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten later
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-openai-request-id, openai-request-id",
};

const DEFAULT_MODEL = "gpt-4.1-mini";

/** Parse JSON safely */
function safeParse(json) {
  try { return JSON.parse(json || "{}"); } catch { return {}; }
}

/** Build OpenAI request body from incoming payload */
function buildOpenAIRequestBody({ message, model, stream, ...rest }) {
  const cleanMsg =
    typeof message === "string" && message.trim().length
      ? message.trim()
      : "health check";

  const body = {
    model: model && typeof model === "string" ? model : DEFAULT_MODEL,
    input: cleanMsg,
    ...(stream ? { stream: true } : {}),
  };

  // copy through a few optional knobs, if provided
  if (typeof rest.temperature === "number") body.temperature = rest.temperature;
  if (typeof rest.max_output_tokens === "number") body.max_output_tokens = rest.max_output_tokens;
  if (rest.metadata && typeof rest.metadata === "object") body.metadata = rest.metadata;

  return body;
}

/** Return JSON response */
function json(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(data),
  };
}

/** Return SSE response (not used here; streaming lives in Edge) */
function sse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...extraHeaders,
    },
    body,
    isBase64Encoded: false,
  };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  // Method guard
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed. Use POST." });
  }

  // 🔒 simple shared-key auth
  const hdrs = event.headers || {};
  const clientKey = hdrs["x-client-key"] || hdrs["X-Client-Key"];
  const expected = process.env.PUBLIC_API_KEY || "";
  if (!expected || clientKey !== expected) {
    return json(401, { error: "Unauthorized" });
  }

  // Env guard
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Missing OPENAI_API_KEY" });
  }

  // Parse incoming payload
  const parsed = safeParse(event.body);
  const openAIReq = buildOpenAIRequestBody(parsed);

  try {
    const rsp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(openAIReq),
    });

    // Pass-through response JSON
    const data = await rsp.json().catch(() => ({}));

    // Bubble up OpenAI status
    // Also expose request id to caller if present
    const reqId = rsp.headers.get("x-request-id") || rsp.headers.get("x-openai-request-id") || "";
    const extra = reqId ? { "x-openai-request-id": reqId } : {};
    return json(rsp.status, data, extra);
  } catch (err) {
    return json(500, { error: String(err) });
  }
};
