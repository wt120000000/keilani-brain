// netlify/functions/chat.js
// Purpose: Decide when to search; if searching, call our search function,
// then ask OpenAI to respond with SPECIFICS + a short opinionated take.
// Tone: engaged, natural; no filler unless slow path triggers on the client.

const fetch = require("node-fetch");
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function wantSearch(text = "") {
  const t = text.toLowerCase();
  const timey =
    /\btoday\b|\bthis (week|month)\b|\blatest\b|\bjust (dropped|released|updated)\b|\bpatch notes\b/.test(
      t
    );
  const verbs = /\b(look it up|check online|search|google|find out)\b/.test(t);
  return timey || verbs;
}

async function callLocalSearch(q) {
  const origin =
    process.env.URL /* Netlify */ ||
    process.env.DEPLOY_URL /* fallback */ ||
    "http://localhost:8888";
  const url = `${origin}/.netlify/functions/search`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q, fresh: true, max: 6 }),
  });
  const js = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`search ${res.status}: ${JSON.stringify(js)}`);
  return js;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const { user_id = "global", message = "", emotion_state = null } = JSON.parse(
      event.body || "{}"
    );

    const shouldSearch = wantSearch(message);

    let searchPack = null;
    if (shouldSearch) {
      // Push the user’s exact intent; let search.js structure the facts
      searchPack = await callLocalSearch(message);
    }

    // Build system prompt to keep Keilani grounded & specific
    const system =
      "You are Keilani, an engaged, warm assistant. Be concise, specific, and curious.\n" +
      "Ask 1 clarifying question only when it meaningfully unlocks a better answer. Avoid generic filler.\n" +
      "When given search facts, synthesize concrete bullets (characters/skins, weapons, map, modes, balance) and add a short, tasteful opinion.\n" +
      "Match the user’s tone lightly (never overdo slang). 2–4 short sentences max unless the user asks for detail.\n";

    const messages = [
      { role: "system", content: system },
    ];

    if (searchPack?.answer) {
      messages.push({
        role: "system",
        content:
          "Fresh web notes (already filtered for specifics):\n" +
          searchPack.answer,
      });
    }

    messages.push({
      role: "user",
      content: message,
    });

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.45,
      messages,
    });

    const reply = resp.choices?.[0]?.message?.content?.trim() || "Got it.";

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply,
        next_emotion_state: emotion_state || null,
        meta: {
          searched: !!shouldSearch,
          sources: searchPack?.results?.slice(0, 4) || [],
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "chat_error", detail: String(err?.message || err) }),
    };
  }
};
