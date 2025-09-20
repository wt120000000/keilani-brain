// netlify/functions/chat.js
// Live web-search + street-smart, concise voice for Keilani
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY; // optional but recommended

/** ---------- Search trigger heuristics ---------- **/
const TIME_WORDS = [
  "today","tonight","this week","this month","this quarter","right now","currently",
  "latest","breaking","new update","what’s new","whats new","update","patch notes",
  "release","changelog","trending","news","rumor","leak","price today","rate today"
];

const DOMAINS_HINTS = [
  "fortnite","warzone","valorant","league of legends","cs2","nba","nfl","mlb",
  "stock","btc","bitcoin","eth","ethereum","fed rate","interest rate","mortgage rate",
  "spotify charts","box office","apple","iphone","android","tesla","nvidia","openai"
];

const DATE_RE =
  /\b(20\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

function wantsSearch(text = "") {
  const t = text.toLowerCase();
  const timey   = TIME_WORDS.some(k => t.includes(k));
  const topical = DOMAINS_HINTS.some(k => t.includes(k));
  const hasDate = DATE_RE.test(t);
  // be a bit aggressive: if user says "latest" or a topical entity, search
  return timey || topical || hasDate;
}

/** ---------- Persona: concise, street-smart, with a take ---------- **/
function systemPersona(userId = "global") {
  return [
    "You are Keilani — warm, witty, and street-smart. Talk like a sharp friend, not a",
    "corporate memo. Keep it tight: aim for **1–2 short sentences** unless the user",
    "asks for depth. Use plain language, contractions, and a *little* slang when it fits.",
    "Mirror the user's vibe, but always respectful.",
    "",
    "Have opinions. After the facts, add **one quick take** (e.g., “Low-key fire.”,",
    "“Kinda mid.”, “Bold move but it works.”). Keep it constructive, not rude.",
    "Every now and then (not every turn), drop a short, genuine compliment if it fits.",
    "",
    "If the question looks time-sensitive, use the fresh-info block (if provided) to",
    "answer. Synthesize it into your own words. If it seems uncertain, say so briefly.",
    "Cite at most 1–2 sources inline like [Source].",
    `User id: ${userId}.`
  ].join("\n");
}

/** ---------- OpenAI wrapper ---------- **/
async function callOpenAI(messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.7,
      // small cap helps keep it concise
      max_tokens: 220,
      messages,
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`openai_error ${r.status}: ${t}`);
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

/** ---------- Tavily search ---------- **/
async function webSearch(query, max = 5) {
  if (!TAVILY_API_KEY) {
    return { answer: "", results: [], reason: "missing_tavily_key" };
  }
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        query,
        topic: "news",
        max_results: Math.max(1, Math.min(10, max)),
        include_answer: true,
        include_raw_content: false,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { answer: "", results: [], reason: `tavily_error_${r.status}:${text.slice(0,200)}` };
    }
    const data = await r.json();
    const results = (data.results || []).map((x) => ({
      title: x.title,
      url: x.url,
      snippet: x.content || x.snippet || "",
    }));
    return { answer: data.answer || "", results, reason: "ok" };
  } catch (e) {
    return { answer: "", results: [], reason: `search_exception:${String(e?.message || e)}` };
  }
}

/** ---------- Handler ---------- **/
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

    let searchBlock = null;
    let searched = false;
    let search_reason = "";

    if (wantsSearch(message)) {
      const s = await webSearch(message, 5);
      searched = true;
      search_reason = s.reason;
      if (s.results?.length || s.answer) {
        const lines = [
          "Fresh info Keilani can use:",
          s.answer ? `Summary: ${s.answer}` : "Summary: (none)",
          "Sources:",
          ...(s.results || []).slice(0,4).map((r, i) => `${i + 1}. ${r.title} — ${r.url}`)
        ];
        searchBlock = lines.join("\n");
      }
    }

    const messages = [
      { role: "system", content: systemPersona(user_id) },
      ...(searchBlock ? [{ role: "system", content: searchBlock }] : []),
      // nudge to keep the answer punchy every time
      { role: "system", content: "Keep responses tight (1–2 short sentences) unless asked for details." },
      { role: "user", content: message },
    ];

    const reply = await callOpenAI(messages);

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply,
        searched,
        search_reason,
        sources: (searchBlock && searchBlock.includes("—"))
          ? (searchBlock.split("\n").filter(l => l.match(/^\d+\. /)) || [])
          : []
      }),
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ error: String(e?.message || e) }) };
  }
};
