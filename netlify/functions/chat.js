// netlify/functions/chat.js
// Fresh-info search + opinionated persona
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";

/** ---------- Search trigger heuristics ---------- **/
const TIME_WORDS = [
  "today","tonight","this week","this month","this quarter","right now","currently",
  "latest","breaking","new update","what’s new","what is new","update","patch notes",
  "release","changelog","trending","news","rumor","leak","price today","rate today"
];

const DOMAINS_HINTS = [
  // things users often want “as of now”
  "fortnite","warzone","valorant","league of legends","cs2","nba","nfl","mlb","stock",
  "btc","eth","fed rate","interest rate","mortgage rate","weather","spotify charts",
  "box office","taylor swift","openai","apple","iphone","android","tesla","nvidia"
];

// quick & forgiving date sniff (e.g., “September 18, 2025”, “9/18/25”, “2025-09-18”)
const DATE_RE =
  /\b(20\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

function wantsSearch(text = "") {
  const t = text.toLowerCase();
  const timey  = TIME_WORDS.some(k => t.includes(k));
  const topical = DOMAINS_HINTS.some(k => t.includes(k));
  const hasDate = DATE_RE.test(t);
  return timey || topical || hasDate;
}

/** ---------- Persona ---------- **/
function systemPersona(userId = "global") {
  return [
    "You are Keilani — warm, witty, practical, and a little sassy. You speak in tight,",
    "useful paragraphs. Be confident. A touch of playful edge is welcome but stay kind.",
    "Have opinions. After giving facts, add one short, subjective take —",
    "keep it constructive (e.g., “I’m into it…”, “Kinda mid…”, “Bold move, but works.”).",
    "Occasionally (not every turn) include a brief, tasteful compliment toward the user",
    "(one short sentence max). Keep compliments natural and earned.",
    "If you used external sources, synthesize; do NOT paste long quotes. Cite at most",
    "1–2 short sources inline like [Source].",
    `User id: ${userId}.`
  ].join("\n");
}

/** ---------- OpenAI ---------- **/
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

/** ---------- Search (Tavily) with graceful fallback ---------- **/
async function webSearch(query, max = 5) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return { answer: "", results: [], reason: "missing_tavily_key" };
  }
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
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
        searchBlock = {
          summary: s.answer || "",
          sources: s.results.slice(0, 4),
        };
      }
    }

    const messages = [
      { role: "system", content: systemPersona(user_id) },
      ...(searchBlock
        ? [{
            role: "system",
            content: [
              "Fresh info Keilani can use (summarize + have a take):",
              `Summary: ${searchBlock.summary || "(none)"}`,
              "Sources:",
              ...(searchBlock.sources || []).map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join("\n"),
              "Use the sources to anchor key facts, then add your short opinionated take.",
              "If info seems stale or uncertain, say so briefly and hedge appropriately.",
            ].join("\n"),
          }]
        : []),
      { role: "user", content: message },
    ];

    const reply = await callOpenAI(messages);

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply,
        searched,
        search_reason,
        sources: searchBlock?.sources || [],
      }),
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ error: String(e?.message || e) }) };
  }
};
