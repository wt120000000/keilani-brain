/**
 * Netlify Function: /api/chat  →  /.netlify/functions/chat
 * Modern OpenAI Responses API (model + input).
 * Accepts:
 *   { message: string, model?: string, stream?: boolean, temperature?: number, max_output_tokens?: number, metadata?: object }
 *   or legacy { messages: Array<{role, content}>, ... }
 * Streams if stream=true (Edge route is preferred for low-latency).
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten later
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_MODEL = "gpt-4.1-mini";
const MIN_OUTPUT_TOKENS = 16; // enforce sane floor to prevent 400s

/* ------------ helpers ------------ */
const json = (statusCode, data, extraHeaders = {}) => ({
  statusCode,
  headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
  body: JSON.stringify(data),
});

const sse = (statusCode, body, extraHeaders = {}) => ({
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
});

const safeParse = (raw) => {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
};

/** Normalize to a single string for Responses API "input" */
function normalizeInput(payload) {
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }
  if (Array.isArray(payload.messages) && payload.messages.length) {
    const lines = payload.messages
      .filter(m => m && typeof m.content === "string")
      .map(m => `${(m.role || "user").toUpperCase()}: ${m.content.trim()}`);
    if (lines.length) return lines.join("\n");
  }
  return "health check";
}

/** Build Responses API request body with guards */
function buildOpenAIRequestBody(payload) {
  const {
    model,
    stream,
    temperature,
    max_output_tokens,
    metadata,
  } = payload || {};

  const body = {
    model: (typeof model === "string" && model.trim()) ? model.trim() : DEFAULT_MODEL,
    input: normalizeInput(payload || {}),
  };

  // Optional params
  if (stream === true) body.stream = true;
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    body.temperature = temperature;
  }
  if (typeof max_output_tokens === "number" && Number.isFinite(max_output_tokens)) {
    // Floor to prevent backend 400s on tiny values
    body.max_output_tokens = Math.max(MIN_OUTPUT_TOKENS, Math.floor(max_output_tokens));
  }
  if (metadata && typeof metadata === "object") {
    // Only include string-valued, flat keys
    const clean = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (typeof v === "string") clean[k] = v;
    }
    if (Object.keys(clean).length) body.metadata = clean;
  }

  return body;
}

/* ------------ handler ------------ */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed. Use POST." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Missing OPENAI_API_KEY" });
  }

  const payload = safeParse(event.body);
  const openaiReq = buildOpenAIRequestBody(payload);

  try {
    const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), 60_000);

    const rsp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(openaiReq),
      signal: controller?.signal,
    });

    clearTimeout(timeout);

    const requestId = rsp.headers.get("x-request-id") || rsp.headers.get("openai-request-id") || undefined;

    if (openaiReq.stream === true) {
      const bodyText = await rsp.text();
      return sse(rsp.status, bodyText, requestId ? { "x-openai-request-id": requestId } : undefined);
    }

    const data = await rsp.json().catch(() => ({}));
    return json(rsp.status, data, requestId ? { "x-openai-request-id": requestId } : undefined);

  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    const isAbort = msg.toLowerCase().includes("aborted");
    return json(isAbort ? 504 : 500, { error: msg });
  }
};
