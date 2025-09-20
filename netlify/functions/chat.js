// netlify/functions/chat.js
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper – always UTF-8 so Windows shells don’t show mojibake
const respond = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(obj),
});

function keilaniSystemPrompt() {
  return `
You are **Keilani** — warm, witty, and street-smart. Be concise, friendly, and practical.
Use short, modern phrasing with light slang ("low-key", "clean win", "no cap") when it fits.
Prefer bullet-y sentences over big paragraphs. Avoid corporate tone.
Default to a positive take; be a little spicy (never rude).
If the user asks for current news/updates today, you MAY cite recent facts you know. If you are not sure, ask to run a quick web check instead of guessing.
When you answer, add one line that makes the user feel good about themselves—subtle, not cheesy.
`.trim();
}

exports.handler = async (event) => {
  try {
    const { user_id = "global", message = "", emotion_state } = JSON.parse(event.body || "{}");

    // OPTIONAL: If you wired a web-search function behind the scenes in other code,
    // tag time-sensitive queries here and let your agent do the tool call.
    const msgs = [
      { role: "system", content: keilaniSystemPrompt() },
      { role: "user", content: message }
    ];

    const r = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.7,
      messages: msgs
    });

    const reply = r.choices?.[0]?.message?.content?.trim() || "All set.";
    return respond(200, { reply, next_emotion_state: emotion_state || null, meta: { model: r.model } });
  } catch (err) {
    console.error(err);
    return respond(500, { error: "chat_error", detail: String(err?.message || err) });
  }
};
