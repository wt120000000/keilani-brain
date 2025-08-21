// ESM version (no CommonJS `exports`)
const redact = (v) => (v ? `${v.slice(0,4)}…(${v.length})` : "MISSING");

export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok:false, error:"Method Not Allowed" }) };
  }

  console.log("---- /api/chat ----", {
    method: event.httpMethod,
    query: event.queryStringParameters,
    ctype: event.headers["content-type"],
  });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const SUPABASE_URL   = process.env.SUPABASE_URL;
  const SUPABASE_KEY   = process.env.SUPABASE_KEY;

  console.log("env check:", {
    OPENAI_API_KEY: redact(OPENAI_API_KEY),
    SUPABASE_URL: SUPABASE_URL ? "SET" : "MISSING",
    SUPABASE_KEY: redact(SUPABASE_KEY),
  });

  if (!OPENAI_API_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, stage:"env", error:"OPENAI_API_KEY missing" }) };
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) {
    console.error("parse error:", e);
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, stage:"parse", error:"Invalid JSON body" }) };
  }

  const { userId, message } = body;
  if (!message || typeof message !== "string") {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, stage:"validate", error:"Missing 'message' (string)" }) };
  }

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are Keilani—warm, upbeat, concise." },
          { role: "user", content: message }
        ],
        temperature: 0.7
      })
    });

    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}
    console.log("openai.status:", r.status);

    if (r.status >= 400) {
      console.error("openai.errorBody:", text);
      return { statusCode: 502, headers: cors, body: JSON.stringify({ ok:false, stage:"chat", error:`OpenAI HTTP ${r.status}`, upstream:text.slice(0,400) }) };
    }

    const reply = json?.choices?.[0]?.message?.content ?? "(no content)";
    const response = { ok:true, userId: userId || null, reply, meta: { model: json?.model, created: json?.created } };
    console.log("response:", response);

    return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(response) };
  } catch (err) {
    console.error("fatal:", err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, stage:"chat", error: err?.message || "unknown error" }) };
  }
};
