// netlify/functions/chat-stream.js
// POST { message, voice?, history?: [{role:"user"|"assistant", text:string}] }
// -> text/event-stream with { delta: "..." } chunks and a final [DONE]
//
// Uses OpenAI *Chat Completions* streaming (stable).
// - CommonJS (no ESM) for your eslint/husky
// - Backoff on 429/5xx
// - Non-streaming fallback if stream cannot be opened
// - Keeps your short session memory from the client

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
const json = (status, body) => ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    // Any chat-completions-capable model works; defaults to gpt-4o-mini
    const MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
    if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "invalid_json" }); }

    const userText = (body.message || "").trim();
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
    if (!userText) return json(400, { error: "missing_text" });

    // Build chat.completions messages
    const messages = [
      {
        role: "system",
        content:
          "You are Keilani: concise, warm, and helpful. Keep responses brief unless asked. If the user is vague, ask one short clarifying question.",
      },
      ...history
        .filter(h => h && h.text)
        .map(h => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.text.trim() }))
        .slice(-10),
      { role: "user", content: userText },
    ];

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function openaiRequest(path, opts) {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch(`https://api.openai.com/v1/${path}`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(opts),
          });
          if (resp.ok) return resp;
          if (resp.status === 429 || (resp.status >= 500 && resp.status <= 599)) {
            await sleep(300 * Math.pow(2, attempt));
            continue;
          }
          lastErr = await resp.text().catch(() => "");
          break;
        } catch (e) {
          lastErr = String(e?.message || e);
          await sleep(300 * Math.pow(2, attempt));
        }
      }
      throw new Error(lastErr || "openai_request_failed");
    }

    // Try STREAMING first via chat.completions
    let upstream = null;
    try {
      upstream = await openaiRequest("chat/completions", {
        model: MODEL,
        messages,
        stream: true,
      });
    } catch (e) {
      // Fallback to NON-STREAM (one-shot) and re-emit as SSE
      const nonStream = await openaiRequest("chat/completions", {
        model: MODEL,
        messages,
        stream: false,
      });
      const j = await nonStream.json().catch(() => ({}));
      let fullText = "";
      if (Array.isArray(j?.choices) && j.choices.length) {
        const c = j.choices[0];
        fullText = c?.message?.content || c?.text || "";
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          send({ event: "start" });
          if (fullText) send({ delta: fullText });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: SSE_HEADERS });
    }

    // Streaming available
    if (!upstream?.body) {
      // Rare: OK but no body; use non-stream fallback
      const nonStream = await openaiRequest("chat/completions", {
        model: MODEL,
        messages,
        stream: false,
      });
      const j = await nonStream.json().catch(() => ({}));
      let fullText = "";
      if (Array.isArray(j?.choices) && j.choices.length) {
        const c = j.choices[0];
        fullText = c?.message?.content || c?.text || "";
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          send({ event: "start" });
          if (fullText) send({ delta: fullText });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: SSE_HEADERS });
    }

    // Translate OpenAI's SSE to {delta} SSE
    const reader  = upstream.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        send({ event: "start" });

        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);

            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();

            if (data === "[DONE]") {
              // OpenAI end marker — we'll finalize after loop
              continue;
            }

            try {
              const evt = JSON.parse(data);
              // Standard chat.completions stream payload:
              // { id, choices: [{ delta: { role?, content? }, finish_reason, ... }], ... }
              const choice = Array.isArray(evt?.choices) ? evt.choices[0] : null;
              const piece  = choice?.delta?.content || "";
              if (piece) send({ delta: piece });
            } catch {
              // Forward raw if not JSON
              if (data) send({ delta: data });
            }
          }
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() { try { reader.cancel(); } catch {} },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  } catch (e) {
    console.error("[chat-stream] error", e);
    return json(500, { error: "chat_stream_exception", detail: String(e?.message || e) });
  }
};
