// netlify/functions/chat.mjs
// Node 18+ on Netlify has global fetch

// --- CORS: allow only your site(s) + local dev ---
const ALLOWED_ORIGINS = new Set([
  "https://keilani.ai",
  "https://www.keilani.ai",
  "http://localhost:8888", // netlify dev
  "http://localhost:5173", // vite dev (if you use it)
]);

function makeCors(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://keilani.ai";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

// --- tiny helpers ---
function json(status, headers, data) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  };
}

function parseBody(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

// --- main handler ---
export async function handler(event) {
  const origin = event.headers?.origin || "";
  const CORS = makeCors(origin);

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  // Enforce POST
  if (event.httpMethod !== "POST") {
    return json(405, CORS, { ok: false, error: "Method Not Allowed" });
  }

  // Parse input
  const body = parseBody(event.body);
  if (!body) {
    return json(400, CORS, { ok: false, error: "Invalid JSON body" });
  }

  const qs = event.queryStringParameters || {};
  const ignoreContext = qs.nocontext === "1" || qs.nocontext === "true";

  const userId = (body.userId || "anonymous").toString();
  const message = (body.message || "").toString().trim();

  if (!message) {
    return json(400, CORS, { ok: false, error: "Missing 'message'." });
  }

  // Env/config
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini-2024-07-18";

  if (!apiKey) {
    return json(500, CORS, { ok: false, error: "OPENAI_API_KEY not set." });
  }

  // Build prompt (inject memory later when !ignoreContext)
  const input = [
    {
      role: "system",
      content:
        "You are Keilani, a friendly, concise AI companion. Be helpful, encouraging, on-brand, and safe.",
    },
    { role: "user", content: message },
  ];

  try {
    const rsp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        // temperature: 0.7, // uncomment/tune if you want
      }),
    });

    const data = await rsp.json();

    if (!rsp.ok) {
      // Don’t leak upstream details to clients; log server-side only.
      console.error("OpenAI upstream error:", rsp.status, data);
      return json(502, CORS, { ok: false, error: "Upstream model error" });
    }

    // Responses API: prefer output[0].content[0].text; fallback to output_text
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Sorry, I had trouble responding.";

    // Optional metadata passthrough
    const created = data?.created ?? Math.floor(Date.now() / 1000);

    return json(200, CORS, {
      ok: true,
      userId,
      reply,
      meta: {
        model,
        created,
        nocontext: !!ignoreContext,
      },
    });
  } catch (err) {
    console.error("chat.mjs fatal error:", err);
    return json(500, CORS, { ok: false, error: "Server error" });
  }
}
