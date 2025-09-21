// netlify/functions/search.js
// Standardizes web search through serper.dev and summarizes w/ OpenAI

const fetch = require("node-fetch");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: defensive fetch with timeout
async function timedFetch(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function pickFields(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "POST only" };
    }

    const { q, max = 6, fresh = true } = JSON.parse(event.body || "{}");
    if (!q || typeof q !== "string") {
      return { statusCode: 400, body: JSON.stringify({ error: "bad_request", detail: "q is required" }) };
    }

    const SERPER_API_KEY = process.env.SERPER_API_KEY;
    if (!SERPER_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "missing_serper_key" }) };
    }

    // Prefer official sources first
    const query =
      `${q} site:fortnite.com OR site:epicgames.com ` +
      "OR site:gamespot.com OR site:ign.com OR site:eurogamer.net";

    // 1) Hit Serper /search
    const sRes = await timedFetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": SERPER_API_KEY,
      },
      body: JSON.stringify({ q: query, gl: "us", hl: "en", num: Math.min(10, Math.max(3, max)) }),
    }, 9000);

    if (!sRes.ok) {
      const errText = await sRes.text().catch(() => "");
      return {
        statusCode: sRes.status,
        body: JSON.stringify({ error: "serper_error", status: sRes.status, detail: errText }),
      };
    }

    const payload = await sRes.json();
    const items = [
      ...(payload.organic || []),
      ...(payload.news || []),
      ...(payload.answerBox ? [payload.answerBox] : []),
      ...(payload.topStories || []),
    ];

    const results = items
      .slice(0, max)
      .map((it) => ({
        title: it.title || it.snippet || it.source || "Result",
        url: it.link || it.url || it.source || "",
        snippet: it.snippet || it.description || "",
        date: it.date || it.publishedDate || "",
        source: it.source || (it.link && new URL(it.link).hostname) || "",
      }))
      .filter(r => r.url);

    if (results.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ answer: "No fresh sources found.", results: [] }) };
    }

    // 2) Ask OpenAI to extract specifics
    const sys =
      "You are a sharp, concise news explainer. Pull SPECIFICS from the snippets/links: new characters/skins, item changes, map POIs, balance changes, release numbers. Cite inline with [1],[2]… matching the index of results array.";

    const user = [
      { role: "user", content:
        `Question: ${q}\n` +
        "Summarize the most recent & concrete details. Provide a short bullet list, then 1–2 lines of opinionated take (bold a standout change)." +
        `\n\nSources (JSON):\n${JSON.stringify(results, null, 2)}`
      }
    ];

    const chat = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [{ role: "system", content: sys }, ...user],
      temperature: 0.2,
      max_tokens: 400,
    });

    const answer = chat.choices?.[0]?.message?.content?.trim() || "No summary.";

    return {
      statusCode: 200,
      body: JSON.stringify({ answer, results }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "search_function_error", detail: String(err && err.message || err) }),
    };
  }
};
