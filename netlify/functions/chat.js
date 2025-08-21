exports.handler = async (event) => {
  const redact = (v) => (v ? `${v.slice(0,4)}…(${v.length})` : "MISSING");
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ ok:false, error:"Method Not Allowed" }) };

  console.log("---- /api/chat request ----", {
    method: event.httpMethod,
    query: event.queryStringParameters,
    ctype: event.headers["content-type"]
  });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  console.log("env:", { OPENAI_API_KEY: redact(OPENAI_API_KEY), SUPABASE_URL: SUPABASE_URL ? "SET" : "MISSING", SUPABASE_KEY: redact(SUPABASE_KEY) });

  if (!OPENAI_API_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, stage:"env", error:"OPENAI_API_KEY missing" }) };

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } 
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, stage:"parse", error:"Invalid JSON body" }) }; }

  const { userId, message } = body;
  if (!message || typeof message !== "string") return { statusCode: 400, headers: cors, body: JSON.stringify({ ok:false, stage:"validate", error:"Missing 'message' (string)" }) };

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are Keilani, warm and upbeat." },
          { role: "user", content: message },
        ],
        temperature: 0.7
      })
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}
    if (r.status >= 400) { console.error("openai.errorBody:", text); throw new Error(`OpenAI HTTP ${r.status}`); }

    const reply = json?.choices?.[0]?.message?.content ?? "(no content)";
    const response = { ok:true, userId: userId || null, reply, meta: { model: json?.model, created: json?.created } };
    console.log("response:", response);
    return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(response) };
  } catch (err) {
    console.error("chat handler fatal:", err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, stage:"chat", error: err?.message || "unknown error" }) };
  }
};
