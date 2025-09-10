// netlify/functions/chat.js
import fetch from "node-fetch";

export default async (req, res) => {
  if (req.method === "OPTIONS") {
    return res.status(200).set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    }).end();
  }

  try {
    const { messages, model, stream } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: "Missing required 'messages' array",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "gpt-5", // default fallback
        messages,
        stream: !!stream,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).send(errorText);
    }

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      response.body.pipe(res);
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
/* netlify/functions/chat.js (CommonJS, classic Lambda style) */
exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS, 'Content-Type': 'text/plain' },
      body: 'Method Not Allowed',
    };
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers: { ...CORS, 'Content-Type': 'text/plain' },
        body: 'Missing OPENAI_API_KEY on server',
      };
    }

    // Parse body
    let bodyJson = {};
    try { bodyJson = JSON.parse(event.body || '{}'); } catch {}
    const { model, message, messages /* stream ignored for classic Lambda */ } = bodyJson;

    // Normalize to OpenAI chat-completions messages[]
    const msgs = Array.isArray(messages) && messages.length
      ? messages
      : [{ role: 'user', content: String(message || '') }];

    // Build upstream payload (omit temperature for gpt-5)
    const upstreamBody = {
      model: model || 'gpt-4o-mini',
      messages: msgs,
    };

    // Call OpenAI (non-stream)
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(upstreamBody),
    });

    // Relay upstream response as-is
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json';

    return {
      statusCode: upstream.status || 200,
      headers: { ...CORS, 'Content-Type': contentType },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'text/plain' },
      body: `Proxy error: ${err.message}`,
    };
  }
};
