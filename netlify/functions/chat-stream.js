// netlify/functions/chat-stream.js
// Streams directly from OpenAI → re-emit as SSE. With per-IP rate limiting.

import { allow } from "./_ratelimit.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};
const SSE_HEADERS = {
  ...CORS,
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function openAIStreamRequest(body, { retries = 2, baseDelay = 500, maxDelay = 2500 } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  let attempt = 0;
  // retry loop
  while (true) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok && (resp.status === 429 || resp.status >= 500) && attempt < retries) {
        const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) + Math.random()*150;
        attempt++; await sleep(delay); continue;
      }
      return resp;
    } catch (e) {
      if (attempt >= retries) throw e;
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) + Math.random()*150;
      attempt++; await sleep(delay);
    }
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST")   return json(405, { error: "method_not_allowed" });

  // 9) rate limit
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'anon';
  const cap = Number(process.env.RL_TOKENS || 30);
  const rps = Number(process.env.RL_REFILL_PER_SEC || 1.5);
  if (!allow(ip, { capacity: cap, refillPerSec: rps })) {
    return json(429, { error: "rate_limited" });
  }

  let payload = {};
  try { payload = await req.json(); } catch { return json(400, { error: "bad_json" }); }

  const userMessage = (payload?.message || "").toString();
  if (!userMessage) return json(400, { error: "missing_message" });

  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  const systemPrompt = process.env.SYSTEM_PROMPT || "You are Keilani, a helpful assistant.";

  const oaiBody = {
    model,
    stream: true,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage }
    ],
    temperature: 0.7
  };

  let upstream;
  try { upstream = await openAIStreamRequest(oaiBody); }
  catch (e) { return json(502, { error: "openai_connect_error", detail: String(e?.message || e) }); }

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    return json(upstream.status || 502, { error: "openai_error", raw: raw?.slice(0, 2000) });
  }

  const enc = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = "";
      const push = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data);
              const delta = obj?.choices?.[0]?.delta?.content || "";
              if (delta) push({ delta });
            } catch { /* ignore */ }
          }
        }
      } catch (e) {
        push({ error: "stream_error", detail: String(e?.message || e) });
      } finally {
        controller.enqueue(enc.encode(`data: [DONE]\n\n`));
        controller.close();
      }
    }
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
};
