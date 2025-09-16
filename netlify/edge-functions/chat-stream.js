// netlify/edge-functions/chat-stream.js
// Edge Function (ESM) — streams OpenAI Chat Completions as SSE { delta: "..." }.
// POST { message, history?: [{role:"user"|"assistant", text:string}] }

export default async (request) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    const MODEL = Deno.env.get("OPENAI_CHAT_MODEL") || "gpt-4o-mini";
    if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

    let body = {};
    try { body = await request.json(); }
    catch { return json(400, { error: "invalid_json" }); }

    const userText = String(body?.message || "").trim();
    const history  = Array.isArray(body?.history) ? body.history.slice(-10) : [];
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
        .map(h => ({
          role: h.role === "assistant" ? "assistant" : "user",
          content: String(h.text || "").trim(),
        }))
        .slice(-10),
      { role: "user", content: userText },
    ];

    // OpenAI streaming request from the edge
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, messages, stream: true }),
    });

    // If streaming not available, do one-shot and re-emit as SSE
    if (!upstream.ok || !upstream.body) {
      const fallback = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, messages }),
      });

      let fullText = "";
      if (fallback.ok) {
        const j = await fallback.json().catch(() => ({}));
        if (Array.isArray(j?.choices) && j.choices.length) {
          fullText = j.choices[0]?.message?.content || j.choices[0]?.text || "";
        }
      }

      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
            send({ event: "start" });
            if (fullText) send({ delta: fullText });
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: sseHeaders() }
      );
    }

    // Translate OpenAI SSE -> { delta } SSE for the client
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    const enc = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        send({ event: "start" });

        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            try {
              const evt = JSON.parse(data);
              const choice = Array.isArray(evt?.choices) ? evt.choices[0] : null;
              const piece  = choice?.delta?.content || "";
              if (piece) send({ delta: piece });
            } catch {
              if (data) send({ delta: data });
            }
          }
        }

        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() { try { reader.cancel(); } catch {} },
    });

    return new Response(stream, { headers: sseHeaders() });
  } catch (err) {
    console.error("[edge chat-stream] exception", err);
    return json(500, { error: "chat_stream_exception", detail: String(err?.message || err) });
  }
};

// ---------- helpers ----------
const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
});

const sseHeaders = () => ({
  ...corsHeaders(),
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
});

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });

// Optional (TOML already binds routes; this is harmless to keep)
export const config = { path: "/api/chat-stream" };
