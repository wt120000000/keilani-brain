// netlify/edge-functions/chat-stream.mjs
// Edge streaming with initial telemetry event
// - POST { message, userId }
// - calls your memory-search function to get memCount/memMode & top matches
// - emits one SSE "telemetry" event, then proxies OpenAI's SSE stream

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL   = Deno.env.get("OPENAI_MODEL")   ?? "gpt-4o-mini";
const MEM_SEARCH_URL = "https://api.keilani.ai/.netlify/functions/memory-search";

// Small JSON response helper for errors
function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function buildMemSummary(results = []) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return results.slice(0, 5).map((r) => `- ${r.summary}`).join("\n");
}

export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

  let payload;
  try { payload = await request.json(); } catch (e) { return json(400, { error: "invalid_json" }); }
  const { message, userId } = payload ?? {};
  if (!message || !userId) return json(400, { error: "missing_fields", detail: "Provide { message, userId }" });

  // 1) get memory search results (best-effort)
  let memInfo = { memCount: 0, memMode: "none", results: [] };
  try {
    const memResp = await fetch(MEM_SEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId, query: message, limit: 5 }),
    });
    if (memResp.ok) {
      const mj = await memResp.json().catch(() => null);
      memInfo.memCount = mj?.count ?? 0;
      memInfo.memMode  = mj?.mode  ?? "none";
      memInfo.results  = mj?.results ?? [];
    }
  } catch (e) {
    // continue without memory info
  }

  // 2) build messages with memory context
  const memoryText = buildMemSummary(memInfo.results);
  const systemParts = [
    "You are Keilani — friendly, concise, and helpful.",
    "If user memories are present, weave them in naturally without exposing raw data.",
  ];
  if (memoryText) systemParts.push("Memories:\n" + memoryText);

  const messages = [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: message },
  ];

  const openaiBody = {
    model: OPENAI_MODEL,
    stream: true,
    messages,
    // omit engine-only fields like max_output_tokens; rely on env / defaults
  };

  // 3) call OpenAI streaming completions
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(openaiBody),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json(502, { error: "upstream_openai_error", status: upstream.status, detail });
  }

  // 4) create a ReadableStream that first emits telemetry as an SSE data: block,
  //    then forwards raw bytes from OpenAI unchanged (so clients see their regular SSE lines).
  const upstreamReader = upstream.body.getReader();

  const stream = new ReadableStream({
    async start(controller) {
      // Emit first SSE telemetry event
      try {
        const telemetry = {
          type: "telemetry",
          memCount: memInfo.memCount,
          memMode: memInfo.memMode,
          timestamp: new Date().toISOString(),
        };
        const telemetrySse = `data: ${JSON.stringify(telemetry)}\n\n`;
        controller.enqueue(new TextEncoder().encode(telemetrySse));
      } catch (e) {
        // noop - still continue to pipe upstream
      }

      // Pipe upstream chunks through as-is
      async function pump() {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) {
            // upstream finishes: ensure final newline or SSE termination if needed
            controller.close();
            return;
          }
          // value is Uint8Array; forward
          controller.enqueue(value);
          await pump();
        } catch (err) {
          try { controller.error(err); } catch (_) {}
        }
      }
      pump();
    },
    cancel(reason) {
      try { upstreamReader.cancel(reason).catch(()=>{}); } catch (_) {}
    },
  });

  const headers = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
  };

  return new Response(stream, { status: 200, headers });
};

// Optional: Deno Edge binding (Netlify may auto-bind by path)
// export const config = { path: "/api/chat-stream" };
