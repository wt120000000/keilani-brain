// Simple JSON chat (non-stream) used by index.html
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: "method_not_allowed" }) };

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "missing_openai_key" }) };

  let message = "", history = [];
  try {
    const body = JSON.parse(event.body || "{}");
    message = String(body.message || "");
    history = Array.isArray(body.history) ? body.history : [];
  } catch (e) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "invalid_json", detail: String(e.message || e) }) };
  }
  if (!message) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "missing_text" }) };

  const msgs = [];
  for (const h of history) if (h?.role && h?.content) msgs.push({ role: h.role, content: String(h.content).slice(0, 4000) });
  msgs.push({ role: "user", content: message.slice(0, 4000) });

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", stream: false, messages: msgs })
    });
    const text = await resp.text();
    if (!resp.ok) return { statusCode: resp.status, headers: cors(), body: JSON.stringify({ error: "openai_error", detail: text }) };
    const data = JSON.parse(text);
    const reply = data?.choices?.[0]?.message?.content || "";
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ reply, matches: [] }) };
  } catch (e) {
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "chat_exception", detail: String(e.message || e) }) };
  }
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Content-Type": "application/json"
  };
}
