// netlify/functions/chat.js
// BUILD: 2025-09-21T02:10Z
// - Broader search trigger (look it up / check online / what's new / update today / etc.)
// - Fast search with timeout (2.5s); graceful fallback if slow
// - Concise, natural persona with subtle mirroring

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

// Free/basic search service key you added in Netlify env:
const SUPERDEV_API_KEY = process.env.SUPERDEV_API_KEY;
const SEARCH_ENDPOINT  = "https://api.superdevresources.com/search";

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function bad(code, error, detail) {
  return { statusCode: code, headers: cors(), body: JSON.stringify({ error, detail }) };
}

/** More generous detector for “please search” intent */
const SEARCH_PHRASES = [
  "search:",            // explicit prefix
  "look it up",
  "look this up",
  "look that up",
  "check online",
  "check the web",
  "check the internet",
  "google it",
  "bing it",
  "find the latest",
  "what's new",
  "what is new",
  "update today",
  "latest update",
  "patch notes",
  "release notes",
  "news today",
  "current price",
  "today", "tonight", "this week", "this month", "this year", "right now"
];

function wantsSearch(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (m.startsWith("search:")) return true;
  return SEARCH_PHRASES.some(p => m.includes(p));
}

/** Do a quick web search with timeout; normalize compact notes */
async function doSearch(q, timeoutMs = 2500) {
  if (!SUPERDEV_API_KEY) return { notes: null, error: "no_search_key" };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SUPERDEV_API_KEY
      },
      body: JSON.stringify({ q, count: 5, fresh: true }),
      signal: ctrl.signal
    });
    clearTimeout(t);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { notes: null, error: `search_${res.status}` };

    const items = (data.results || []).map((r, i) =>
      `(${i + 1}) ${r.title || ""}\n${(r.snippet || "").trim()}\nSource: ${r.url || ""}`
    );
    const notes = items.slice(0, 5).join("\n\n");
    return { notes, error: null };
  } catch (e) {
    clearTimeout(t);
    return { notes: null, error: "search_timeout_or_network" };
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors() };
    if (event.httpMethod !== "POST")   return bad(405, "method_not_allowed", "Use POST");

    if (!OPENAI_API_KEY) return bad(500, "missing_openai_key", "Set OPENAI_API_KEY");

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e) { return bad(400, "invalid_json", e.message); }

    const message = (body.message || "").toString().trim();
    const user_id = body.user_id || "global";
    const emotion_state = body.emotion_state || null;
    const last_transcript = (body.last_transcript || message || "").slice(-400);

    if (!message) return bad(400, "missing_message", "Expected 'message' (string).");

    // Decide if we should search
    const shouldSearch = wantsSearch(message);
    let webNotes = null;
    let usedSearch = false;

    if (shouldSearch) {
      const query = message.replace(/^search\s*:/i, "").trim() || message;
      const { notes } = await doSearch(query, 2500);
      if (notes) { webNotes = notes; usedSearch = true; }
    }

    const persona = [
      "You are Keilani. Warm, grounded, concise.",
      "Speak naturally in 2–5 sentences.",
      "Subtly mirror the user's vibe/wording if helpful (light touch).",
      "Ask at most one short, relevant follow-up if it helps you assist.",
      "Give a clear, respectful opinion when asked (one strong reason).",
      "If search notes are provided, synthesize them; avoid link dumps."
    ].join(" ");

    const msgs = [
      { role: "system", content: persona },
      emotion_state ? { role: "system", content: `Conversation affect: ${JSON.stringify(emotion_state)}` } : null,
      { role: "system", content: `Recent user phrasing sample (for subtle mirroring only): ${last_transcript}` },
      webNotes ? { role: "system", content: `Fresh web notes (summarize, keep it tight):\n${webNotes}` } : null,
      { role: "user", content: message }
    ].filter(Boolean);

    const req = {
      model: MODEL,
      messages: msgs,
      temperature: 0.5,
      max_tokens: 420,
      presence_penalty: 0.1,
      frequency_penalty: 0.2
    };

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(req)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return bad(res.status, "openai_chat_error", data);

    const reply = data?.choices?.[0]?.message?.content?.trim()
      || "Sorry—could you rephrase that?";

    return {
      statusCode: 200,
      headers: cors({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        reply,
        next_emotion_state: null,
        meta: { model: MODEL, used_search: usedSearch }
      })
    };
  } catch (err) {
    return bad(500, "server_error", String(err?.message || err));
  }
};
