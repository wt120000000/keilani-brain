// netlify/functions/chat.js
// Plain JSON chat endpoint that injects user memories from our Netlify function.

const fetch = require("node-fetch");

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Content-Type": "application/json; charset=utf-8",
};

const ok  = (body) => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify(body) });
const bad = (body) => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify(body) });

function getOrigin(event) {
  const proto = (event.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host  = (event.headers["x-forwarded-host"]  || event.headers.host || "").split(",")[0].trim();
  if (host) return `${proto}://${host}`;
  if (process.env.URL) return process.env.URL;
  return "https://api.keilani.ai";
}

function isRecallQuery(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("what did i say") ||
    t.includes("do you remember") ||
    t.includes("what do you remember") ||
    t.includes("remember what i said") ||
    t.includes("earlier") ||
    t.includes("last time") ||
    t.includes("previously")
  );
}

function buildSystemPrompt(memories) {
  const lines = [];
  lines.push("You are Keilani, a friendly AI voice companion.");
  if (memories?.length) {
    lines.push("Known user memories (most recent first):");
    for (const m of memories) {
      const tags = Array.isArray(m.tags) && m.tags.length ? ` [tags: ${m.tags.join(", ")}]` : "";
      const imp  = Number.isFinite(m.importance) ? ` (importance ${m.importance})` : "";
      lines.push(`- ${m.summary}${tags}${imp}`);
    }
  } else {
    lines.push("No prior memories matched this query.");
  }
  lines.push("Be concise and helpful. If a memory is relevant, weave it naturally into your response.");
  return lines.join("\n");
}

async function fetchMemories(origin, { userId, query, limit = 8, allowRecentFallback = false }) {
  let results = [];
  try {
    const r = await fetch(`${origin}/.netlify/functions/memory-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, query, limit }),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.ok && Array.isArray(j.results)) results = j.results;
  } catch (e) {
    console.warn("memory-search failed:", e?.message || e);
  }

  if (allowRecentFallback && results.length === 0) {
    try {
      const r = await fetch(`${origin}/.netlify/functions/memory-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // empty query => your memory-search treats this as "latest"
        body: JSON.stringify({ userId, query: "", limit }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok && Array.isArray(j.results)) results = j.results;
    } catch (e) {
      console.warn("memory-search fallback failed:", e?.message || e);
    }
  }

  return results;
}

async function callOpenAI(systemPrompt, userMsg) {
  const model  = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model,
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.4),
      max_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 300),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
    }),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`OpenAI ${r.status}: ${txt}`);
  }
  const j = await r.json();
  return j?.choices?.[0]?.message?.content ?? "";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });
  if (event.httpMethod !== "POST") return bad({ error: "method_not_allowed" });

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch {}

  const message = payload.message || "";
  const userId  = payload.userId || null;

  if (!message) return bad({ error: "missing_message" });

  const origin = getOrigin(event);

  // Pull memories (with recent fallback for recall-type questions)
  const allowRecentFallback = isRecallQuery(message);
  const memories = userId
    ? await fetchMemories(origin, { userId, query: message, allowRecentFallback, limit: 8 })
    : [];

  const system = buildSystemPrompt(memories);

  try {
    const reply = await callOpenAI(system, message);
    return ok({
      reply,
      // echo a compact view so you can verify memory injection from the client/PowerShell
      memoriesUsed: memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        created_at: m.created_at,
        tags: m.tags,
        importance: m.importance,
      })),
    });
  } catch (e) {
    return bad({ error: "upstream_error", detail: String(e.message || e) });
  }
};
