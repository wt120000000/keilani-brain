// netlify/functions/chat.js (CommonJS)
// POST { message, system?, model?, temperature?, history? }
// -> { reply }

const ok = (obj, extra = {}) => ({
  statusCode: 200,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  },
  body: JSON.stringify(obj),
});

const err = (status, msg) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify({ error: msg }),
});

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

  if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");
  if (!process.env.OPENAI_API_KEY) return err(500, "Missing OPENAI_API_KEY");

  try {
    const input = JSON.parse(event.body || "{}");
    const {
      message,
      system,
      model = "gpt-5",
      temperature = 0.7,
      history = [],
    } = input;

    if (!message || typeof message !== "string") return err(400, "Missing 'message' (string)");

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    if (Array.isArray(history)) {
      for (const m of history) {
        if (m && typeof m.content === "string" && ["system","user","assistant"].includes(m.role)) {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }
    messages.push({ role: "user", content: message });

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, temperature }),
    });

    if (!res.ok) return err(res.status, `OpenAI error: ${await res.text()}`);
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content ?? "";
    return ok({ reply });
  } catch (e) {
    return err(500, `chat exception: ${e.message}`);
  }
};
