/**
 * Netlify Function: /api/chat (CommonJS)
 * - GET: health JSON
 * - POST: proxy to OpenAI chat completions
 * - OPTIONS: CORS preflight
 * Security: optional CLIENT_TOKEN (Authorization: Bearer <token>)
 * Env: OPENAI_API_KEY (required), CLIENT_TOKEN (optional)
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

function requireClientAuth(event) {
  const expected = process.env.CLIENT_TOKEN;
  if (!expected) return null; // no auth enforced
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === expected ? null : "Unauthorized";
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS, body: "" };
    }

    if (event.httpMethod === "GET") {
      return json(200, { ok: true, service: "keilani-chat", method: "GET" });
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    // Optional client auth
    const authErr = requireClientAuth(event);
    if (authErr) return json(401, { error: authErr });

    // Body
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const {
      message,
      model = "gpt-4.1",
      temperature = 0.7,
      stream = true,
      system,
    } = body;

    if (!message || typeof message !== "string") {
      return json(400, { error: "Missing 'message' (string)" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json(500, { error: "OPENAI_API_KEY not configured" });

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
      console.error("Upstream error", upstreamRes.status, detail.slice(0, 500));
      return json(upstreamRes.status, { error: "Upstream error", detail: detail.slice(0, 2000) });
    }

    if (!stream) {
      const data = await upstreamRes.json();
      const out =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.map((c) => c?.delta?.content || c?.message?.content || "").join("") ??
        "";
      return json(200, { output: out, raw: data });
    }

    // SSE streaming
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
        const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

        try {
          const reader = upstreamRes.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = dec.decode(value);
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
                send({ content: payload });
              }
            }
          }
        } catch (err) {
          console.error("Stream error:", err);
          send({ error: String(err?.message || err) });
        } finally {
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });

    return new Response(streamBody, { status: 200, headers });
  } catch (err) {
    console.error("Handler crashed:", err);
    return json(500, { error: "Handler crashed", detail: String(err?.message || err) });
  }
};
