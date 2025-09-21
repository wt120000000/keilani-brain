// netlify/functions/chat.js
// Routes user text → (optional) web search → OpenAI; returns reply + next_emotion_state

const fetch = require("node-fetch");
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SEARCH_FN = `${process.env.URL || "https://api.keilani.ai"}/.netlify/functions/search`;

function shouldSearch(text) {
  if (!text) return false;

  // explicit override
  if (/^search:/i.test(text)) return true;

  // time-sensitive phrasing
  const recency = /(today|this week|latest|right now|just (dropped|released)|patch notes|update)/i.test(text);

  // task verbs implying lookup
  const lookup = /(look (it|this) up|check online|what (changed|added)|can you (check|find))/i.test(text);

  return recency || lookup;
}

function personaSystem() {
  return [
    {
      role: "system",
      content:
        "You are Keilani: warm, helpful, naturally conversational. " +
        "Keep replies tight. Ask one smart follow-up if needed. " +
        "If web data is provided, be SPECIFIC (names, items, numbers). " +
        "One subtle compliment about the user when appropriate. " +
        "Avoid filler unless the client announces a loading cue.",
    },
  ];
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "POST only" };
    }
    const { user_id = "global", message = "" } = JSON.parse(event.body || "{}");
    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: "bad_request", detail: "message is required" }) };
    }

    let web = null;

    if (shouldSearch(message)) {
      // call our own search function (which uses serper.dev)
      const sRes = await fetch(SEARCH_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: message, fresh: true, max: 6 }),
      });
      if (sRes.ok) {
        web = await sRes.json();
      } else {
        // Non-fatal: continue without web data
        web = { answer: "(Search failed)", results: [] };
      }
    }

    const messages = [
      ...personaSystem(),
      web
        ? {
            role: "system",
            content:
              "You have fresh web context. Use it precisely. Prefer concrete details over generalities.\n" +
              `Web summary:\n${web.answer}\n\nLinks:\n${(web.results || [])
                .map((r, i) => `[${i + 1}] ${r.title} — ${r.url}`)
                .join("\n")}`,
          }
        : null,
      { role: "user", content: message },
    ].filter(Boolean);

    const chat = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      temperature: web ? 0.3 : 0.6,
      max_tokens: 350,
    });

    const reply = chat.choices?.[0]?.message?.content?.trim() || "Got it.";
    return {
      statusCode: 200,
      body: JSON.stringify({
        reply,
        next_emotion_state: null,
        meta: { searched: !!web, provider: "serper.dev" },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "chat_function_error", detail: String(err && err.message || err) }),
    };
  }
};
