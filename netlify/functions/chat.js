// netlify/functions/chat.js
// CommonJS + SDK-free fetch (Node 18+ has global fetch)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const BASE_ORIGIN =
  process.env.BASE_ORIGIN || "https://api.keilani.ai"; // your prod
const SEARCH_FN = `${BASE_ORIGIN}/.netlify/functions/search`;

const SEARCH_TRIGGERS = [
  "today",
  "this week",
  "latest",
  "just dropped",
  "new patch",
  "patch notes",
  "update",
  "changes",
  "release notes",
  "look it up",
  "search",
];

function needsSearch(text = "") {
  const t = String(text).toLowerCase();
  return SEARCH_TRIGGERS.some((k) => t.includes(k));
}

// Tiny vibe-scoring from titles/snippets. Returns "excited" | "meh" | "neutral"
function detectVibe(results = []) {
  const pos = [
    "major",
    "big",
    "huge",
    "celebrat",
    "awesome",
    "epic",
    "finally",
    "powerful",
    "buff",
    "new mode",
    "new map",
    "collab",
    "dropped",
  ];
  const neg = [
    "delay",
    "delayed",
    "nerf",
    "bug",
    "issue",
    "problem",
    "controversy",
    "mixed",
    "underwhelming",
    "meh",
    "disappoint",
  ];

  let score = 0;
  for (const r of results) {
    const hay = `${r.title || ""} ${r.snippet || ""}`.toLowerCase();
    if (pos.some((w) => hay.includes(w))) score += 1;
    if (neg.some((w) => hay.includes(w))) score -= 1;
  }
  if (score >= 2) return "excited";
  if (score <= -1) return "meh";
  return "neutral";
}

async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.6,
      max_tokens: 550,
      messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status} ${detail}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function buildSystemPrompt({ vibe, results }) {
  // Collapse sources for grounding
  const lines = (results || []).slice(0, 6).map((r, i) => {
    const src = r.source || new URL(r.url || "", "https://x.invalid").hostname;
    return `• ${r.title || "(untitled)"} — ${src}\n  ${r.snippet || ""}`;
  });

  // Style rules for Keilani
  return [
    "You are Keilani — warm, sharp, and efficient.",
    "You must stay grounded in the sources provided. Do NOT invent specifics.",
    "Output structure:",
    "1) **Hot take opener (1 sentence)** that matches the overall tone. If vibe='excited', be upbeat. If 'meh', be gently skeptical. If 'neutral', be balanced. No headline recitation.",
    "2) **3–5 tight bullets**: specific changes, dates, items, characters, weapons, etc. Prefer the newest concrete info. Include short parenthetical source tags like (Fortnite News) / (GameSpot).",
    "3) **One helpful follow-up question** to advance the convo.",
    "Voice: conversational, not slangy; brief, not curt; never read titles line-by-line.",
    "If facts conflict, say so briefly and prefer official sources.",
    "",
    `Detected vibe: ${vibe}`,
    "",
    "Sources (summaries):",
    lines.join("\n"),
  ].join("\n");
}

function buildUserPrompt(userText) {
  return [
    "User asked:",
    userText,
    "",
    "Write one concise reply following the structure. No markdown headings beyond simple bullets.",
  ].join("\n");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    const body = JSON.parse(event.body || "{}");
    const user_id = body.user_id || "anon";
    const message = String(body.message || "").trim();

    let searched = false;
    let results = [];
    let answerFromSearch = "";

    // Kick a search when it makes sense
    if (needsSearch(message)) {
      const sRes = await fetch(SEARCH_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: message, fresh: true, max: 8 }),
      });
      if (sRes.ok) {
        const sData = await sRes.json().catch(() => ({}));
        results = Array.isArray(sData.results) ? sData.results : [];
        answerFromSearch = sData.answer || "";
        searched = true;
      }
    }

    // If we’ve got real results, guide GPT with vibe + sources
    if (searched && results.length) {
      const vibe = detectVibe(results);
      const system = buildSystemPrompt({ vibe, results });
      const user = buildUserPrompt(message);

      const reply = await callOpenAI([
        { role: "system", content: system },
        { role: "user", content: user },
      ]);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reply,
          meta: {
            searched,
            vibe,
            citations: results
              .slice(0, 6)
              .map((r) => ({ title: r.title, url: r.url, source: r.source })),
          },
        }),
      };
    }

    // Fallback (non-time-sensitive): straight chat, light guidance
    const systemFallback =
      "You are Keilani — be concise, helpful, and conversational. If you lack live sources, answer from general knowledge, ask a short clarifying follow-up, and avoid making up dates or current events.";
    const userFallback = message;

    const reply = await callOpenAI([
      { role: "system", content: systemFallback },
      { role: "user", content: userFallback },
    ]);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply,
        meta: { searched: false },
      }),
    };
  } catch (err) {
    console.error("[chat] error", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "chat_failed", detail: String(err) }),
    };
  }
};
