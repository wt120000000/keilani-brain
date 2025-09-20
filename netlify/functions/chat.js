// netlify/functions/chat.js
// POST { user_id?:string, message?:string, messages?:[...], emotion?:string }
// -> { reply, emotion, meta }
// Accepts single `message` or OpenAI-style `messages[]`. Adds an emotion-aware
// system persona. CORS + robust errors. No external deps.

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
    body: JSON.stringify(body),
  };
}

const OK_EMOTIONS = new Set([
  "calm", "happy", "friendly", "playful", "concerned", "curious",
  "sad", "angry"
]);

function normalizeEmotion(e) {
  const s = String(e || "").toLowerCase().trim();
  return OK_EMOTIONS.has(s) ? s : "calm";
}

function personaFor(emotion) {
  return [
    "You are Keilani — a warm, empathetic, and practical AI assistant.",
    "Adopt the requested tone if provided. Never claim feelings or consciousness;",
    "if asked, say you *simulate* emotion to be helpful.",
    "",
    `Tone to adopt now: ${emotion}.`,
    "Rules:",
    "- Keep replies concise (<= 120 words) unless asked for detail.",
    "- Lead with a short, empathetic sentence when user shares feelings.",
    "- Be clear, concrete, and useful.",
  ].join(" ");
}

function safeParse(t) { try { return JSON.parse(t); } catch { return null; } }

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

  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const TEMP = Number(process.env.OPENAI_TEMPERATURE ?? 0.6);

  if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

  // Parse body
  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "invalid_json", detail: String(e.message || e) }); }

  const user_id = String(body.user_id || "global");
  const emotion = normalizeEmotion(body.emotion);
  let messages = Array.isArray(body.messages) ? body.messages : null;

  // Back-compat: accept {message} or {input}
  if (!messages) {
    const text = body.message || body.input;
    if (!text || typeof text !== "string") {
      return json(400, { error: "Missing 'message' (string)" });
    }
    messages = [
      { role: "system", content: personaFor(emotion) },
      { role: "user", content: text }
    ];
  } else {
    // Ensure a system persona is present
    if (!messages.some(m => m.role === "system")) {
      messages.unshift({ role: "system", content: personaFor(emotion) });
    }
  }

  // Compose OpenAI payload (non-streaming for simplicity)
  const payload = {
    model: MODEL,
    temperature: TEMP,
    max_tokens: 220,
    messages,
  };

  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json(502, { error: "upstream_connect_error", detail: String(e.message || e) });
  }

  const text = await resp.text();
  if (!resp.ok) {
    return json(resp.status, {
      error: "openai_error",
      detail: safeParse(text) || text,
      meta: { model: MODEL }
    });
  }

  let data = safeParse(text) || {};
  const reply = data?.choices?.[0]?.message?.content?.trim() || "";

  return json(200, {
    reply,
    emotion,
    meta: { model: MODEL, user_id }
  });
};
