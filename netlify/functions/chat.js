// netlify/functions/chat.js
// Decides when to search; if yes, calls our search function;
// then asks OpenAI to reply with specifics + a short opinion.
// No external SDKs (use native fetch). CommonJS.

const OA_URL = "https://api.openai.com/v1/chat/completions";

function wantSearch(text = "") {
  const t = text.toLowerCase();
  const timey =
    /\btoday\b|\bthis (week|month|season)\b|\blatest\b|\bnew(est)?\b|\bpatch notes?\b|\bversion\b/.test(t);
  const explicit = /\b(look it up|check online|search|google|find out|can you look|pull up)\b/.test(t);
  return timey || explicit;
}

async function callLocalSearch(origin, q) {
  const url = `${origin}/.netlify/functions/search`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q, fresh: true }),
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
    const { user_id = "global", message = "", emotion_state = null } = JSON.parse(event.body || "{}");
    const origin =
      process.env.URL ||
      process.env.DEPLOY_URL ||
      "http://localhost:8888";
    const shouldSearch = wantSearch(message);

    let notes = null;
    if (shouldSearch) {
      notes = await callLocalSearch(origin, message);
    }

    const system =
      "You are Keilani. Be natural, helpful, and specific. " +
      "Use any provided 'Fresh notes' to give concrete bullets (characters/skins, weapons, map/POIs, modes/LTMs, balance), " +
      "then add a short tasteful opinion or tip. Keep it 2–4 short sentences unless asked. " +
      "Ask at most one clarifying question only if it truly helps.";

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const messages = [{ role: "system", content: system }];
    if (notes?.answer) {
      messages.push({ role: "system", content: "Fresh notes:\n" + notes.answer });
    }
    messages.push({ role: "user", content: message });

    const body = {
      model: "gpt-4o-mini",
      temperature: 0.45,
      messages,
    };

    const res = await fetch(OA_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const js = await res.json();
    if (!res.ok) throw new Error(`openai ${res.status}: ${JSON.stringify(js)}`);

    const reply = js.choices?.[0]?.message?.content?.trim() || "Got it.";

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply,
        next_emotion_state: emotion_state || null,
        meta: {
          searched: !!shouldSearch,
          sources: notes?.results?.slice(0, 4) || [],
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "chat_error", detail: String(err?.message || err) }) };
  }
};
