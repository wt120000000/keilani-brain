// netlify/functions/chat.js
// Uses native fetch instead of the OpenAI SDK to avoid bundling issues.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";

const respond = (status, obj) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(obj),
});

function keilaniSystemPrompt() {
  return `
You are **Keilani** — warm, witty, and street-smart. Be concise and practical.
Use short, modern phrasing with light slang when it fits (e.g., "low-key", "clean win", "no cap").
Default to a positive take; a little spicy, never rude.
If the user asks for "today/latest/now" and you aren't sure, say you can run a quick web check (your caller may handle that).
Always add one short line that makes the user feel good about themselves — subtle, not cheesy.
`.trim();
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") return respond(405, { error: "method_not_allowed" });
  if (!OPENAI_API_KEY)           return respond(500, { error: "missing_openai_key" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return respond(400, { error: "invalid_json", detail: String(e?.message || e) });
  }

  const user_id = body.user_id || "global";
  const message = (body.message || "").toString().trim();
  const emotion_state = body.emotion_state || null;
  if (!message) return respond(400, { error: "missing_message" });

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.7,
    messages: [
      { role: "system", content: keilaniSystemPrompt() },
      { role: "user",   content: message }
    ]
  };

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    if (!r.ok) {
      return respond(r.status, { error: "openai_error", detail: safeParse(text) || text });
    }
    const data = safeParse(text) || {};
    const reply = data?.choices?.[0]?.message?.content?.trim() || "All set.";
    return respond(200, { reply, next_emotion_state: emotion_state || null, meta: { model: data.model || OPENAI_MODEL } });
  } catch (e) {
    return respond(502, { error: "chat_exception", detail: String(e?.message || e) });
  }
};

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
