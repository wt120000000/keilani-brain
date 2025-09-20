// netlify/functions/chat.js
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SEARCH_TRIGGERS = [
  "today","latest","news","headline","who won","score","stock","price",
  "this week","this month","right now","current","trending","update","weather"
];

function wantsSearch(text="") {
  const t = text.toLowerCase();
  return SEARCH_TRIGGERS.some(k => t.includes(k));
}

function systemPersona(userId="global") {
  return [
    "You are Keilani — warm, witty, practical, and a little sassy.",
    "Style: concise, concrete, respectful; keep answers focused and useful.",
    "You can share a brief, tasteful compliment to the user **once in a while** (max one short sentence).",
    "Have opinions: pick a stance where reasonable, explain *why* briefly.",
    "Default tone is friendly and confident.",
    `User id: ${userId}.`
  ].join("\n");
}

async function callOpenAI(messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers: { "Content-Type":"application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.7,
      messages
    })
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`openai_error ${r.status}: ${t}`);
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

async function maybeSearch(query) {
  try {
    const r = await fetch(`${process.env.URL || ""}/.netlify/functions/search`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ q: query, max_results: 5 })
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data;
  } catch { return null; }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Use POST" };
    }
    if (!OPENAI_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "missing_openai_key" }) };
    }

    const { user_id = "global", message } = JSON.parse(event.body || "{}");
    if (typeof message !== "string" || !message.trim()) {
      return { statusCode: 200, body: JSON.stringify({ error: "Missing 'message' (string)" }) };
    }

    let searchPack = null;
    if (wantsSearch(message)) {
      searchPack = await maybeSearch(message);
    }

    const messages = [
      { role:"system", content: systemPersona(user_id) },
      ...(searchPack ? [{
        role:"system",
        content: [
          "Fresh info that may be relevant:",
          `Summary: ${searchPack.answer || "(none)"}`,
          "Sources:",
          ...(searchPack.results || []).slice(0,3).map((r,i)=>`${i+1}. ${r.title} — ${r.url}`).join("\n"),
          "Use these to answer succinctly and include a short opinion."
        ].join("\n")
      }] : []),
      { role:"user", content: message }
    ];

    const reply = await callOpenAI(messages);
    return {
      statusCode: 200,
      body: JSON.stringify({
        reply,
        searched: !!searchPack,
        sources: searchPack?.results?.slice(0,3) || []
      })
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ error: String(e?.message || e) }) };
  }
};
