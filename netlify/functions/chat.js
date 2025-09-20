// netlify/functions/chat.js
// Chat brain: natural tone, concise, lightly mirror user (10–20%), ask 1 smart follow-up when helpful.
// Uses OpenAI Chat Completions via fetch (no SDK dependency).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    ...extra,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: cors() };
    }
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: "method_not_allowed" }) };
    }
    if (!OPENAI_API_KEY) {
      return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "missing_openai_key" }) };
    }

    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      return bad(400, "invalid_json", e.message);
    }

    const user_id = payload.user_id || "global";
    const message = (payload.message || "").toString().trim();
    const emotion_state = payload.emotion_state || null;
    // optional last transcript (helps light mirroring)
    const last_utterance = (payload.last_transcript || message || "").slice(-400);

    if (!message) {
      return bad(400, "missing_message", "Expected 'message' (string).");
    }

    // Persona: grounded, concise, lightly mirror user tone. One helpful follow-up max.
    const system = [
      "You are Keilani: warm, grounded, and helpful.",
      "Speak naturally. Keep replies concise (2–5 sentences).",
      "Lightly mirror the user's word choice and mood (about 10–20%), not more.",
      "Avoid hype or repetitive slang. No filler like 'just a sec' unless *explicitly* asked to stall.",
      "Offer one focused follow-up question only if it helps you assist better. Otherwise, no extra questions.",
      "If an opinion is requested, take a clear but respectful stance with one reason.",
      "If the user seems down, acknowledge briefly and offer one practical nudge.",
      "Be precise; prefer concrete suggestions and options over vague encouragement.",
    ].join(" ");

    // A short analyzer hint for the model
    const mirrorHint = [
      "User tone sample (recent):",
      last_utterance || "(none)",
      "Lightly mirror, but keep it professional and clear.",
    ].join("\n");

    // Build messages
    const messages = [
      { role: "system", content: system },
      // Tiny tool-free context with emotion / state if provided
      emotion_state
        ? { role: "system", content: `Current conversation affect/state (for subtle delivery only): ${JSON.stringify(emotion_state)}` }
        : null,
      { role: "system", content: mirrorHint },
      { role: "user", content: message },
    ].filter(Boolean);

    const body = {
      model: MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 450,
      // Keep responses crisp
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
    };

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return bad(res.status, "openai_chat_error", data);
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Sorry—mind repeating that in a different way?";

    // Placeholder: if you compute next_emotion_state elsewhere, return it here.
    const next_emotion_state = null;

    return {
      statusCode: 200,
      headers: cors({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        reply,
        next_emotion_state,
        meta: { model: MODEL },
      }),
    };
  } catch (err) {
    return bad(500, "server_error", String(err?.message || err));
  }

  function bad(code, error, detail) {
    return { statusCode: code, headers: cors(), body: JSON.stringify({ error, detail }) };
  }
};
