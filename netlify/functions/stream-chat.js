// netlify/functions/stream-chat.js
"use strict";

/**
 * Stream Chat (v3.4-stream)
 * - Streams token-by-token responses from OpenAI (Server-Sent Events style)
 * - Uses same memory recall logic as chat.js
 * - Designed to work with Edge proxy (/api/chat-stream)
 */

const OpenAI = require("openai");
const VERSION = "chat-mem-v3.4-stream";

function num(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function baseUrl() {
  const u = process.env.DEPLOY_URL || process.env.URL || "https://api.keilani.ai";
  return u.replace(/\/+$/, "");
}

// basic memory recall helper (non-blocking)
async function recallMemories(userId, message) {
  try {
    const url = `${baseUrl()}/.netlify/functions/memory-search`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, query: message, limit: 5 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.results?.length) {
      const lines = data.results.map((r) => `- ${r.summary}`);
      return `Known facts:\n${lines.join("\n")}`;
    }
  } catch (_) {}
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "Method not allowed",
    };
  }

  try {
    const { message, userId } = JSON.parse(event.body || "{}");
    if (!message || !userId) {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: "Missing message or userId",
      };
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const memoryContext = await recallMemories(userId, message);
    const messages = [
      {
        role: "system",
        content:
          "You are Keilani — a warm, lively, engaging AI companion. " +
          "Use a conversational tone and stream your thoughts as you type. " +
          (memoryContext ? `\n${memoryContext}` : ""),
      },
      { role: "user", content: message },
    ];

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: num(process.env.OPENAI_MAX_OUTPUT_TOKENS, 512),
      temperature: num(process.env.OPENAI_TEMPERATURE, 0.3),
      stream: true,
      messages,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of completion) {
            const token = chunk.choices?.[0]?.delta?.content || "";
            if (token) controller.enqueue(encoder.encode(token));
          }
          controller.close();
        } catch (err) {
          controller.enqueue(encoder.encode(`\n[error: ${err.message}]`));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Version": VERSION,
      },
    });
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: `Stream error: ${String(err.message || err)}`,
    };
  }
};
