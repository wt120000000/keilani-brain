/**
 * Netlify Function: /api/chat  (CommonJS)
 * - GET  -> health check JSON
 * - POST -> proxies to OpenAI Chat Completions
 *           supports {stream:true} for SSE, or {stream:false} for JSON
 * - OPTIONS -> CORS preflight
 *
 * Expects env: OPENAI_API_KEY
 *
 * Works with the chat.html payload:
 * { message: string, model?: string, temperature?: number, stream?: boolean, system?: string }
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const json = (status, obj, extra = {}) => ({
  statusCode: status,
  headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  try {
    // CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS, body: "" };
    }

    // Simple health check
    if (event.httpMethod === "GET") {
      return json(200, { ok: true, service: "keilani-chat", method: "GET" });
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    // Parse body
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const {
      message,
      model = "gpt-5",
      temperature = 0.7,
      stream = true,
      system,
    } = body;

    if (!message || typeof message !== "string") {
      return json(400, { error: "Missing 'message' (string)" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json(500, { error: "OPENAI_API_KEY not configured" });
    }

    // Build upstream request
    const upstreamBody = {
      model,
      temperature,
      stream,
      messages: [
        ...(system ? [{ role: "system", content: String(system) }] : []),
        { role: "user", content: message },
      ],
    };

    const upstreamRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!upstreamRes.ok) {
      const detail = await upstreamRes.text();
      return json(upstreamRes.status, { error: "Upstream error", detail: detail.slice(0, 2000) });
    }

    // Non-stream: return JSON once
    if (!stream) {
      const data = await upstreamRes.json();
      const out =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.map((c) => c?.delta?.content || c?.message?.content || "").join("") ??
        "";
      return json(200, { output: out, raw: data });
    }

    // Stream (SSE): translate OpenAI's SSE into minimal deltas {delta:"..."}
    // Netlify Functions support returning a streamed response via Response()
    const headers = {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    };

    const streamBody = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const dec = new TextDecoder();

        // helper: send one SSE data event
        const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

        try {
          const reader = upstreamRes.body.getReader();

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = dec.decode(value);
            // OpenAI sends lines like "data: {...}" and "data: [DONE]"
            for (const line of chunk.split("\n")) {
              const t = line.trim();
              if (!t.startsWith("data:")) continue;
              const payload = t.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;

              try {
                const js = JSON.parse(payload);
                const text =
                  js?.choices?.[0]?.delta?.content ??
                  js?.choices?.[0]?.message?.content ??
                  "";
                if (text) send({ delta: text });
              } catch {
                // If a non-JSON line sneaks through, forward as content
                send({ content: payload });
              }
            }
          }
        } catch (err) {
          send({ error: String(err?.message || err) });
        } finally {
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });

    // Return a native Response so Netlify preserves the stream
    return new Response(streamBody, { status: 200, headers });
  } catch (err) {
    return json(500, { error: "Handler crashed", detail: String(err?.message || err) });
  }
};

/**
 * ROUTING NOTE
 * ------------
 * If you already route /api/chat to this function via netlify.toml redirects, you're set.
 * If not, you can also expose it directly at /.netlify/functions/chat.
 *
 * If you prefer pretty path-based routing without redirects and you're on Functions v2,
 * you can try attaching a path config like below — but this is not required if you have redirects.
 *
 * exports.config = { path: "/api/chat" }; // Uncomment if your setup supports it.
 */
