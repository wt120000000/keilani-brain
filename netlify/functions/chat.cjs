// netlify/functions/chat.js
// CommonJS + native fetch (Node 18+). CORS + OPTIONS + JSON/SSE proxy.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TEXT = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS, ...extra },
  body,
});

const JSONR = (statusCode, obj, extra = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...CORS, ...extra },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: CORS };
    }
    if (event.httpMethod !== "POST") {
      return TEXT(405, "Method Not Allowed");
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_TOKEN;
    if (!OPENAI_API_KEY) {
      return JSONR(500, { error: "Missing OPENAI_API_KEY" });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return JSONR(400, { error: "Invalid JSON" });
    }

    const { model = "gpt-5", messages, stream = true, temperature } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return JSONR(400, { error: "Missing required: messages[]" });
    }

    // Build OpenAI request
    const url = "https://api.openai.com/v1/chat/completions";
    const payload = {
      model,
      messages,
      stream: !!stream,
    };

    // gpt-5 ignores temperature; only include for others
    if (typeof temperature === "number" && !String(model).startsWith("gpt-5")) {
      payload.temperature = temperature;
    }

    // Forward Authorization; prefer server key, ignore client token for OpenAI
    // (Client token from browser may be useful to your own services.)
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const t = await upstream.text().catch(() => "");
      return JSONR(upstream.status, { error: "Upstream error", detail: t });
    }

    // If client expects SSE, forward raw text.
    if (stream) {
      // NOTE: Netlify Functions v1 will buffer; v2/streaming will flush.
      const text = await upstream.text();
      return TEXT(
        200,
        text,
        {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        }
      );
    }

    // Non-stream JSON:
    const data = await upstream.json();
    // Return a simple, consistent shape for the frontend
    const reply =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      "";
    return JSONR(200, { reply, raw: data });
  } catch (err) {
    return JSONR(500, { error: String(err && err.message || err) });
  }
};
