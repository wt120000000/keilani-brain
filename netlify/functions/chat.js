/* netlify/functions/chat.js  — CommonJS, classic Lambda, no imports */

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...CORS, "Content-Type": "text/plain" },
      body: "Method Not Allowed",
    };
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers: { ...CORS, "Content-Type": "text/plain" },
        body: "Missing OPENAI_API_KEY on server",
      };
    }

    // Parse incoming body (from your chat UI)
    let bodyJson = {};
    try { bodyJson = JSON.parse(event.body || "{}"); } catch {}

    const { model, message, messages } = bodyJson;

    // Normalize to OpenAI chat-completions messages[]
    const msgs = Array.isArray(messages) && messages.length
      ? messages
      : [{ role: "user", content: String(message || "") }];

    // Build OpenAI payload (omit temperature for gpt-5)
    const upstreamBody = {
      model: model || "gpt-4o-mini",
      messages: msgs,
    };

    // Call OpenAI (non-streaming for classic Lambda reliability)
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(upstreamBody),
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";

    return {
      statusCode: upstream.status || 200,
      headers: { ...CORS, "Content-Type": contentType },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, "Content-Type": "text/plain" },
      body: `Proxy error: ${err.message}`,
    };
  }
};
