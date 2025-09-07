const CORS = {
  "Access-Control-Allow-Origin": "*", // tighten later
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-openai-request-id, openai-request-id",
};

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

function buildOpenAIRequestBody(payload) {
  const DEFAULT_MODEL = "gpt-4.1-mini";
  const message = typeof payload.message === "string" && payload.message.trim()
    ? payload.message.trim()
    : "health check";
  const model = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : DEFAULT_MODEL;

  const body = { model, input: message, stream: true };
  if (typeof payload.temperature === "number") body.temperature = payload.temperature;
  if (typeof payload.max_output_tokens === "number") body.max_output_tokens = payload.max_output_tokens;
  if (payload.metadata && typeof payload.metadata === "object") body.metadata = payload.metadata;
  return body;
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed. Use POST." }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // 🔒 shared-key auth
  const clientKey = request.headers.get("x-client-key");
  const expected = (typeof Deno !== "undefined" && Deno.env && Deno.env.get) ? (Deno.env.get("PUBLIC_API_KEY") || "") : "";
  if (!expected || clientKey !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const apiKey = (typeof Deno !== "undefined" && Deno.env && Deno.env.get) ? (Deno.env.get("OPENAI_API_KEY") || "") : "";
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const payload = await readJson(request);
  const body = buildOpenAIRequestBody(payload);

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const reqId = upstream.headers.get("x-request-id") || upstream.headers.get("x-openai-request-id") || undefined;

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...(reqId ? { "x-openai-request-id": reqId } : {}),
    },
  });
}
