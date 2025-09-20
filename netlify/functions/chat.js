// netlify/functions/chat.js
// Keilani server chat with optional live web search via Serper.dev (CommonJS)

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const SERPER_API_KEY   = process.env.SERPER_API_KEY; // set this in Netlify
const OPENAI_MODEL     = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_SERP_RESULTS = 5;

const respond = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function shouldSearch(msg) {
  const q = (msg || "").toLowerCase().trim();
  if (q.startsWith("search:")) return true;

  const freshness = [
    "today","tonight","yesterday","tomorrow",
    "latest","new","just dropped","breaking","this week","this month",
    "update","patch notes","changelog","price now","stock now",
    "who won","score","weather","traffic",
    "fortnite update","season","chapter"
  ];
  if (freshness.some(k => q.includes(k))) return true;
  if (/\b20\d{2}\b/.test(q)) return true;
  if (/\b(v|ver|version)\s*\d+(\.\d+)?/.test(q)) return true;
  if (/\b[A-Z]{2,5}\b/.test(q) && q.includes("stock")) return true;
  return false;
}

async function webSearch(query) {
  if (!SERPER_API_KEY) {
    // Return "ok: false" but don't crash; frontend will still get an answer.
    return { ok: false, reason: "missing_serper_key", results: [] };
  }

  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: MAX_SERP_RESULTS, gl: "us", hl: "en" }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, reason: `serper_${res.status}`, raw: text, results: [] };
  }

  const data = await res.json().catch(() => ({}));
  const pick = [];
  const push = (arr = []) => arr.forEach(r => {
    if (pick.length >= MAX_SERP_RESULTS) return;
    pick.push({
      title: r.title || r.source || r.snippet?.slice(0, 80) || "result",
      link: r.link || r.url,
      snippet: r.snippet || r.description || "",
      date: r.date || r.aboutThisResult?.date || ""
    });
  });

  push(data.organic);
  push(data.news);

  return { ok: true, results: pick };
}

function keilaniSystemPrompt(nowISO) {
  return `
You are **Keilani** — warm, witty, down-to-earth, a little spicy, and always kind.
Speak **concise, punchy, modern** English with light slang (e.g., "low-key", "clean win").
You **uplift the user** and keep answers **accurate + practical**, with a tasteful **opinionated take**.

Rules:
- Keep replies short (2–6 sentences). No rambles. Use bullets if it adds clarity.
- If web search was used, say that politely and weave facts in naturally; only include raw links if the user asks.
- If something’s uncertain, say so and suggest what to watch next.
- End with a tiny next step or question.
- Never expose secrets, keys, or internals.

Current time: ${nowISO}
`.trim();
}

function buildUserPrompt(userMsg, searchPack, nowISO) {
  if (!searchPack?.ok || !searchPack.results?.length) {
    return `
User said: "${userMsg}"

No web search used for this message. Answer in Keilani's voice, compact, helpful, and a bit opinionated.
`.trim();
  }

  const lines = searchPack.results.map((r, i) => {
    const dt = r.date ? ` (${r.date})` : "";
    return `- [${i + 1}] ${r.title}${dt}: ${r.snippet}`;
  }).join("\n");

  return `
User said: "${userMsg}"

We ran a quick web search (summary below; links on request). Latest snippets:
${lines}

Answer in Keilani's voice with a clear, benevolent take when appropriate.
Keep it concise. Mention freshness like "as of ${new Date(nowISO).toLocaleDateString()}".
`.trim();
}

async function callOpenAI(messages, temperature = 0.65) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature,
      max_tokens: 400,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openai_${res.status}: ${text}`);
  }
  const data = await res.json().catch(() => ({}));
  return (data.choices?.[0]?.message?.content || "").trim();
}

function emotionFor(text) {
  const t = (text || "").toLowerCase();
  let style = 0.55, stability = 0.55, similarity = 0.7;
  if (t.includes("great") || t.includes("love") || t.includes("excited")) style = 0.7;
  if (t.includes("bad") || t.includes("concern")) { stability = 0.65; style = 0.45; }
  return {
    stability: clamp01(stability),
    similarity: clamp01(similarity),
    style: clamp01(style),
  };
}

// Classic Netlify handler (CommonJS)
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return respond(405, { error: "method_not_allowed" });
    }

    const body = JSON.parse(event.body || "{}");
    const user_id = body.user_id || "global";
    const message = (body.message || body.input || "").toString().trim();

    if (!message) return respond(200, { error: "Missing 'message' (string)" });

    const nowISO = new Date().toISOString();

    const willSearch = shouldSearch(message);
    let searchPack = { ok: false, results: [] };
    if (willSearch) {
      searchPack = await webSearch(message.replace(/^search:\s*/i, ""));
    }

    const system = keilaniSystemPrompt(nowISO);
    const user = buildUserPrompt(message, searchPack, nowISO);
    const reply = await callOpenAI([
      { role: "system", content: system },
      { role: "user",   content: user }
    ]);

    const next_emotion_state = emotionFor(reply);

    return respond(200, {
      reply,
      next_emotion_state,
      meta: {
        searched: willSearch,
        search_ok: !!searchPack.ok,
        results: (searchPack.results || []).map(r => ({ title: r.title, link: r.link })),
        model: OPENAI_MODEL,
        now: nowISO
      }
    });
  } catch (err) {
    console.error("chat_error", err);
    // 200 with error payload keeps the frontend flow happy
    return respond(200, { error: "chat_error", detail: String(err?.message || err) });
  }
};
