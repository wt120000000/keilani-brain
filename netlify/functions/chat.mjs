// netlify/functions/chat.mjs

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten later to https://keilani.ai
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function handler(event) {
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: false, error: "Method Not Allowed" }),
    };
  }

  try {
    const qs = event.queryStringParameters || {};
    const ignoreContext = qs.nocontext === "1" || qs.nocontext === "true";

    const body = JSON.parse(event.body || "{}");
    const userId = body.userId || "anonymous";
    const message = (body.message || "").toString().trim();

    if (!message) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: false, error: "Missing 'message'." }),
      };
    }

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini-2024-07-18";
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: false, error: "OPENAI_API_KEY not set." }),
      };
    }

    // Later: if !ignoreContext, fetch memory from Supabase and prepend here.
    const input = [
      {
        role: "system",
        content:
          "You are Keilani, a friendly, concise AI companion. Be helpful, encouraging, and on-brand.",
      },
      { role: "user", content: message },
    ];

    const rsp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input }),
    });

    const data = await rsp.json();

    if (!rsp.ok) {
      console.error("OpenAI error:", rsp.status, data);
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          ok: false,
          error: "Upstream model error",
          details: data,
        }),
      };
    }

    // Responses API: prefer output[0].content[0].text; fallback to output_text.
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Sorry, I had trouble responding.";

    const payload = {
      ok: true,
      userId,
      reply,
      meta: { model },
    };

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error("chat.mjs fatal error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: false, error: "Server error" }),
    };
  }
}
