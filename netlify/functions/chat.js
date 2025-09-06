/**
 * Netlify Function: /api/chat  →  /.netlify/functions/chat
 * Uses OpenAI Responses API (model + input). No deprecated chat/completions.
 * - POST body: { message: string, model?: string, stream?: boolean }
 * - CORS preflight supported
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain when ready
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_MODEL = "gpt-4.1-mini";

/** Parse JSON safely */
function safeParse(json) {
  try { return JSON.parse(json || "{}"); } catch { return {}; }
}

/** Build OpenAI request body from incoming payload */
function buildOpenAIRequestBody({ message, model, stream }) {
  const cleanMsg =
    typeof message === "string" && message.trim().length
      ? message.trim()
      : "health check";

  return {
    model: model && typeof model === "string" ? model : DEFAULT_MODEL,
    input: cleanMsg,
    ...(stream ? { stream: true } : {}),
  };
}

/** Return JSON response */
function json(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(data),
  };
}

/** Return SSE response (streaming passthrough) */
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

  // Env guard
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Missing OPENAI_API_KEY" });
  }

  // Parse incoming payload
  const { message, model, stream } = safeParse(event.body);

  // Build OpenAI request
  const openAIReq = buildOpenAIRequestBody({ message, model, stream });

  try {
    const rsp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(openAIReq),
    });

    // Streaming passthrough
    if (openAIReq.stream) {
      // Netlify supports returning a ReadableStream body directly
      // We pass through OpenAI's SSE stream unchanged.
      return sse(rsp.status, await rsp.text());
    }

    // Non-streaming JSON
    const data = await rsp.json();

    // Pass through OpenAI status (200 for success, 4xx/5xx for errors)
    return json(rsp.status, data);
  } catch (err) {
    // Network or unexpected error
    return json(500, { error: String(err) });
  }
};
