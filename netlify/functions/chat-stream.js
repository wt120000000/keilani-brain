// netlify/functions/chat-stream.js
// POST { message, voice?, history?: [{role:"user"|"assistant", text:string}] }
// -> text/event-stream with { delta: "..." } chunks and a final [DONE]
//
// Notes
// - CJS (no ESM) to satisfy your eslint/husky rules
// - Uses OpenAI "responses" streaming API and translates to simple SSE for the client
// - Short system prompt + optional short history (<= 10 turns recommended)
// - Backoff on 429/5xx

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

const json = (status, body) => ({
  statusCode: status,
  headers: { ...CORS, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
    if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "invalid_json" }); }

    const userText = (body.message || "").trim();
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
    if (!userText) return json(400, { error: "missing_text" });

    // Convert history to "input" messages for Responses API
    const historyInputs = [];
    for (const h of history) {
      const role = h?.role === "assistant" ? "assistant" : "user";
      const text = (h?.text || "").trim();
      if (!text) continue;
      historyInputs.push({ role, content: text });
    }

    // Final input (system + history + current)
    const input = [
      {
        role: "system",
        content:
          "You are Keilani: concise, warm, and helpful. Keep responses brief unless asked. If user is vague, ask a short clarifying question.",
      },
      ...historyInputs,
      { role: "user", content: userText },
    ];

    // Backoff helper
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function openaiStream() {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              input,
              stream: true,
              modalities: ["text"],
            }),
          });
          if (resp.ok && resp.body) return resp;
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
      throw new Error(`openai_stream_failed: ${lastErr || "unknown"}`);
    }

    const upstream = await openaiStream();
    const reader = upstream.body.getReader();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        // Helper to push one SSE data line
        const send = (obj) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        // Read OpenAI SSE and translate to {delta}
        const textDec = new TextDecoder();
        let buffer = "";

        // Emit an initial event so client is ready
        send({ event: "start" });

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += textDec.decode(value, { stream: true });

          // OpenAI responses SSE is line-based
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            let line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);

            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            try {
              const evt = JSON.parse(payload);

              // The streaming text shows up in these delta events:
              // - response.output_text.delta
              // Some models may emit content via "response.delta" too; guard both.
              if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
                send({ delta: evt.delta });
              } else if (evt.type === "response.delta" && evt.delta?.length) {
                // Rare format (array of blocks) — extract text blocks if any
                const textParts = [];
                for (const d of evt.delta) {
                  const t = d?.content?.[0]?.text?.value;
                  if (t) textParts.push(t);
                }
                if (textParts.length) send({ delta: textParts.join("") });
              } else if (evt.type === "response.completed") {
                // end of stream (ignore here; we'll send [DONE] after loop)
              }
            } catch {
              // If it's plain text (shouldn't be), forward as-is
              send({ delta: payload });
            }
          }
        }

        // Close
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        try { reader.cancel(); } catch {}
      },
    });

    // Return streaming response
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (err) {
    console.error("[chat-stream] exception", err);
    return json(500, { error: "chat_stream_exception", detail: String(err?.message || err) });
  }
};
