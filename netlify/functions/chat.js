// netlify/functions/chat.js
// Natural, concise responses. Light mirroring. Optional web search enrichment.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const SUPERDEV_API_KEY = process.env.SUPERDEV_API_KEY; // your free search key (already set)
const SEARCH_ENDPOINT  = "https://api.superdevresources.com/search"; // simple JSON search

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    ...extra,
  };
}

const NEEDS_SEARCH_RE = new RegExp(
  [
    "\\btoday\\b","\\bnow\\b","\\bthis (week|month|year)\\b",
    "\\blatest\\b","\\bcurrent\\b","\\bnews\\b","\\bupdate\\b","\\brecent\\b",
    "\\brelease notes\\b","\\bpatch notes\\b","\\bprice\\b","\\bschedule\\b"
  ].join("|"),
  "i"
);

function wantsSearch(msg) {
  if (!msg) return false;
  if (/^search\s*:/.test(msg)) return true;
  return NEEDS_SEARCH_RE.test(msg);
}

async function doSearch(q) {
  if (!SUPERDEV_API_KEY) return null;
  try {
    const res = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SUPERDEV_API_KEY
      },
      body: JSON.stringify({ q, count: 5, fresh: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(JSON.stringify(data));
    // Normalize a compact “notes” string for the model
    const items = (data.results || []).map((r, i) =>
      `(${i + 1}) ${r.title || ""}\n${(r.snippet || "").trim()}\nSource: ${r.url || ""}`
    );
    return items.slice(0, 5).join("\n\n");
  } catch (_err) {
    return null;
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors() };
    if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: "method_not_allowed" }) };
    if (!OPENAI_API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "missing_openai_key" }) };

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) {
      return bad(400, "invalid_json", e.message);
    }

    const user_id = body.user_id || "global";
    const message = (body.message || "").toString().trim();
    const emotion_state = body.emotion_state || null;
    const last_transcript = (body.last_transcript || message || "").slice(-400);

    if (!message) return bad(400, "missing_message", "Expected 'message' (string).");

    // Optional web search enrichment
    let webNotes = null;
    let queryForSearch = message.replace(/^search\s*:/i, "").trim();
    if (wantsSearch(message)) {
      webNotes = await doSearch(queryForSearch || message);
    }

    const systemPersona = [
      "You are Keilani. Warm, grounded, and helpful.",
      "Speak naturally and concisely (2–5 sentences).",
      "Lightly mirror the user's word choice and mood (~15%), not more.",
      "Ask at most one short, relevant follow-up if it helps you assist.",
      "If an opinion is requested, give a clear, respectful take with one reason.",
      "Avoid hype/slang unless the user used it first.",
    ].join(" ");

    const msgs = [
      { role: "system", content: systemPersona },
      emotion_state ? { role: "system", content: `Conversation affect: ${JSON.stringify(emotion_state)}` } : null,
      { role: "system", content: `Recent user phrasing sample (for subtle mirroring only): ${last_transcript}` },
      webNotes ? { role: "system", content: `Fresh web notes (summarize, don't quote links blindly):\n${webNotes}` } : null,
      { role: "user", content: message }
    ].filter(Boolean);

    const req = {
      model: MODEL,
      messages: msgs,
      temperature: 0.55,
      max_tokens: 400,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
    };

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(req),
      // low-ish timeout via AbortController if desired (Netlify has hard caps anyway)
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
        meta: { model: MODEL, used_search: Boolean(webNotes) }
      })
    };
  } catch (err) {
    return bad(500, "server_error", String(err?.message || err));
  }

  function bad(code, error, detail) {
    return { statusCode: code, headers: cors(), body: JSON.stringify({ error, detail }) };
  }
};
