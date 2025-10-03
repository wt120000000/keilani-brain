// netlify/functions/chat.js
// Chat endpoint that injects user memories (semantic search + guaranteed recent fallback)

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

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  try {
    return { ok: r.ok, status: r.status, json: JSON.parse(text) };
  } catch {
    return { ok: r.ok, status: r.status, json: null, text };
  }
}

// Always try semantic search; if zero, fetch recent N (fallback)
async function getMemoriesWithFallback(origin, { userId, semanticQuery, limit = 8 }) {
  let results = [];
  let mode = "semantic";

  // 1) semantic (query = user message)
  try {
    const { json } = await fetchJson(`${origin}/.netlify/functions/memory-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, query: semanticQuery, limit }),
    });
    if (json?.ok && Array.isArray(json.results)) results = json.results;
  } catch (e) {
    console.warn("memory-search semantic error:", e?.message || e);
  }

  // 2) guaranteed fallback to latest if nothing found
  if (!results.length) {
    mode = "recent_fallback";
    try {
      const { json } = await fetchJson(`${origin}/.netlify/functions/memory-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, query: "", limit }), // empty => latest
      });
      if (json?.ok && Array.isArray(json.results)) results = json.results;
    } catch (e) {
      console.warn("memory-search recent fallback error:", e?.message || e);
    }
  }

  return { results, mode };
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

  if (!message) return bad({ version: "chat-mem-v3", error: "missing_message" });

  const origin = getOrigin(event);

  // Pull memories (semantic then recent)
  const { results: memories, mode: memMode } = userId
    ? await getMemoriesWithFallback(origin, { userId, semanticQuery: message, limit: 8 })
    : { results: [], mode: "no_user" };

  const system = buildSystemPrompt(memories);

  try {
    const reply = await callOpenAI(system, message);
    return ok({
      version: "chat-mem-v3",
      memCount: memories.length,
      memMode,
      memoriesUsed: memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        created_at: m.created_at,
        tags: m.tags,
        importance: m.importance,
      })),
      reply,
    });
  } catch (e) {
    return bad({ version: "chat-mem-v3", error: "upstream_error", detail: String(e.message || e) });
  }
};
