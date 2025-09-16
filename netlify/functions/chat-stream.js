// netlify/functions/chat-stream.js
// POST { message, voice?, history?: [{role:"user"|"assistant", text:string}] }
// -> text/event-stream with { delta: "..." } chunks and a final [DONE]

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
    if (event.httpMethod !== "POST")  return json(405, { error: "method_not_allowed" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
    if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "invalid_json" }); }

    const userText = (body.message || "").trim();
    const history  = Array.isArray(body.history) ? body.history.slice(-10) : [];
    if (!userText) return json(400, { error: "missing_text" });

    // System + (short) history + current message
    const input = [
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

    async function openaiRequest(opts) {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch("https://api.openai.com/v1/responses", {
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

    // Try STREAMING first
    let upstream = null;
    try {
      upstream = await openaiRequest({
        model: MODEL,
        input,
        stream: true,
        modalities: ["text"],
      });
    } catch (e) {
      // If streaming creation itself failed, try NON-STREAMING once, then yield as one SSE payload
      const nonStream = await openaiRequest({
        model: MODEL,
        input,
        stream: false,
        modalities: ["text"],
      });
      const j = await nonStream.json().catch(() => ({}));
      // Four common shapes across models:
      let fullText = "";
      if (j?.output_text) {
        fullText = String(j.output_text || "");
      } else if (Array.isArray(j?.output)) {
        fullText = j.output
          .map(b => {
            const t = b?.content?.[0]?.text?.value;
            return typeof t === "string" ? t : "";
          })
          .join("");
      } else if (Array.isArray(j?.choices)) {
        fullText = j.choices.map(c => c?.message?.content || c?.text || "").join("");
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

    // If we got a streaming response, translate its SSE to {delta} SSE
    if (!upstream?.body) {
      // Extremely rare: server says OK but no body; fallback quickly
      const nonStream = await openaiRequest({ model: MODEL, input, stream: false, modalities: ["text"] });
      const j = await nonStream.json().catch(() => ({}));
      let fullText = j?.output_text || "";
      if (!fullText && Array.isArray(j?.output)) {
        fullText = j.output
          .map(b => b?.content?.[0]?.text?.value || "")
          .join("");
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

          // Responses API returns its own SSE; parse lines
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            try {
              const evt = JSON.parse(data);
              if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
                send({ delta: evt.delta });
              } else if (evt.type === "response.delta" && Array.isArray(evt.delta)) {
                // Extract any text blocks if present
                const parts = [];
                for (const d of evt.delta) {
                  const t = d?.content?.[0]?.text?.value;
                  if (t) parts.push(t);
                }
                if (parts.length) send({ delta: parts.join("") });
              }
            } catch {
              // Forward raw payload if not JSON
              send({ delta: data });
            }
          }
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        try { reader.cancel(); } catch {}
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  } catch (e) {
    console.error("[chat-stream] error", e);
    return json(500, { error: "chat_stream_exception", detail: String(e?.message || e) });
  }
};
