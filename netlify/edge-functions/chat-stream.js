const MODEL  = Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Robust payload parser: JSON, digits-per-line, x-www-form-urlencoded, or URL query.
async function parsePayload(request) {
  const url = new URL(request.url);
  const qp = Object.fromEntries(url.searchParams.entries());

  if (qp.message || qp.userId) {
    return { message: qp.message, userId: qp.userId, agent: qp.agent || "keilani", _source: "query" };
  }

  const ctype = request.headers.get("content-type")?.toLowerCase() || "";

  // JSON first
  try {
    if (ctype.includes("application/json")) {
      const j = await request.json();
      return { ...j, _source: "json" };
    }
  } catch (_) {}

  // x-www-form-urlencoded
  try {
    if (ctype.includes("application/x-www-form-urlencoded")) {
      const body = await request.text();
      const sp = new URLSearchParams(body);
      const obj = Object.fromEntries(sp.entries());
      return { ...obj, _source: "form" };
    }
  } catch (_) {}

  // Fallback: raw text, try to heal “digits-per-line”
  try {
    const raw = await request.text();
    const trimmed = raw.trim();

    // Looks like JSON already?
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const j = JSON.parse(trimmed);
        return { ...j, _source: "text-json" };
      } catch (_) {}
    }

    // digits-per-line → bytes → JSON
    const lines = trimmed.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const allDigits = lines.length > 0 && lines.every(s => /^\d+$/.test(s));
    if (allDigits) {
      const bytes = new Uint8Array(lines.map(n => Number(n) & 0xFF));
      const decoded = new TextDecoder().decode(bytes);
      try {
        const j = JSON.parse(decoded);
        return { ...j, _source: "digits" };
      } catch (_) {
        return { raw, decoded, _source: "digits-raw" };
      }
    }

    return { raw, _source: "raw-text" };
  } catch (e) {
    return { _source: "parse-error", error: String(e) };
  }
}

export default async (request, _context) => {
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive"
  });

  const payload = await parsePayload(request);
  const message = payload?.message;
  const userId  = payload?.userId;
  const agent   = payload?.agent || "keilani";

  // Early SSE ack / diagnostics
  const preface = new ReadableStream({
    start(controller) {
      controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString(), parsedFrom: payload?._source }));
      if (!message || !userId) {
        controller.enqueue(sse({
          type: "delta",
          content: `Missing fields. Need { message, userId }. Received: ${JSON.stringify({
            source: payload?._source,
            sample: Object.fromEntries(Object.entries(payload || {}).slice(0, 4))
          })}\n`
        }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      } else {
        controller.close();
      }
    }
  });

  if (!message || !userId) {
    return new Response(preface, { headers, status: 200 });
  }

  if (!API_KEY) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "telemetry", model: MODEL, ts: new Date().toISOString(), note: "no OPENAI_API_KEY" }));
        controller.enqueue(sse({ type: "delta", content: "Hi! (no OPENAI_API_KEY set)\n" }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      }
    });
    return new Response(body, { headers, status: 200 });
  }

  const body = new ReadableStream({
    async start(controller) {
      // flush preface
      const reader1 = preface.getReader();
      while (true) {
        const { done, value } = await reader1.read();
        if (done) break;
        controller.enqueue(value);
      }

      controller.enqueue(sse({ type: "delta", content: "(connected to OpenAI…)\n" }));

      const system = `You are ${agent}, a helpful, upbeat AI influencer. Keep it concise.`;
      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "authorization": `Bearer ${API_KEY}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: MODEL,
            stream: true,
            messages: [
              { role: "system", content: system },
              { role: "user", content: message }
            ]
          })
        });

        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => "(no body)");
          controller.enqueue(sse({ type: "delta", content: `OpenAI error: ${resp.status} ${text}\n` }));
          controller.enqueue(sse({ type: "done" }));
          controller.close();
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          const rest = parts.pop();
          buffer = (rest !== undefined ? rest : "");

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();

            if (data === "[DONE]") {
              controller.enqueue(sse({ type: "done" }));
              controller.close();
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(sse({ type: "delta", content: delta }));
            } catch {}
          }
        }

        controller.enqueue(sse({ type: "done" }));
        controller.close();
      } catch (err) {
        controller.enqueue(sse({ type: "delta", content: `Edge exception: ${String(err)}\n` }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      }
    }
  });

  return new Response(body, { headers, status: 200 });
};
