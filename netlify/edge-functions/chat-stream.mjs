// netlify/edge-functions/chat-stream.mjs
// Edge streaming with memory recall (Deno runtime)
// - Reads { message, userId } from POST body
// - Pulls top memories via your memory-search function
// - Calls OpenAI Chat Completions with stream=true
// - Pipes OpenAI's SSE directly to the client

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL   = Deno.env.get("OPENAI_MODEL")   ?? "gpt-4o-mini"; // pick your default
const MEM_SEARCH_URL = "https://api.keilani.ai/.netlify/functions/memory-search";

// Small helper for JSON responses
function j(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// Build a short, readable memories block
function formatMemories(results = []) {
  if (!results?.length) return null;
  const lines = results.slice(0, 5).map((r, i) => `- ${r.summary}`);
  return `Known user memories (top matches):\n${lines.join("\n")}`;
}

export default async (request, context) => {
  if (request.method !== "POST") {
    return j(405, { error: "method_not_allowed" }, { allow: "POST" });
  }
  if (!OPENAI_API_KEY) {
    return j(500, { error: "missing_openai_key" });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return j(400, { error: "invalid_json" });
  }

  const { message, userId } = payload ?? {};
  if (!message || !userId) {
    return j(400, { error: "missing_fields", detail: "Provide { message, userId }" });
  }

  // 1) fetch memories (vector-first via your function)
  let memText = null;
  try {
    const memResp = await fetch(MEM_SEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        query: message,
        limit: 5,
      }),
    });
    if (memResp.ok) {
      const memJson = await memResp.json();
      memText = formatMemories(memJson?.results || []);
    }
  } catch (_e) {
    // Non-fatal: continue without memories
  }

  // 2) build prompt with memory context
  const systemParts = [
    "You are Keilani. Be concise, warm, and helpful.",
    "If memories are provided, weave them in naturally—do not expose raw memory objects.",
  ];
  if (memText) systemParts.push(memText);

  const messages = [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user",   content: message },
  ];

  // 3) stream from OpenAI (REST, so it works on Deno/Edge)
  const openaiReqBody = {
    model: OPENAI_MODEL,
    stream: true,
    // temperature optional; your Netlify env can keep OPENAI_TEMPERATURE in the Lambda path
    messages,
    // Ensure compatibility with REST API (no `max_output_tokens` here)
  };

  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(openaiReqBody),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return j(502, { error: "upstream_openai_error", status: upstream.status, detail });
  }

  // 4) Pipe OpenAI SSE straight through
  const headers = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    // CORS for your callers
    "access-control-allow-origin": "*",
  };

  return new Response(upstream.body, { status: 200, headers });
};

export const config = {
  path: "/api/chat-stream", // bind this Edge function directly to the pretty route
};
