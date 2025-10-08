// netlify/functions/chat.js
// Chat with memory fetch (v3.2). CommonJS for maximum Netlify compatibility.

const ok = (body, extraHeaders = {}) => ({
  statusCode: 200,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

const bad = (code, body) => ({
  statusCode: code,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

function baseUrl() {
  // In prod on Netlify, URL is your custom domain; fallback to deploy URL or localhost for dev.
  return (
    process.env.URL ||
    process.env.DEPLOY_URL ||
    process.env.DEPLOY_PRIME_URL ||
    "http://localhost:8888"
  );
}

async function fetchMemories({ userId, query, limit = 5 }) {
  try {
    const r = await fetch(`${baseUrl()}/.netlify/functions/memory-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, query, limit }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j || j.error) {
      return { results: [], mode: "error", error: j?.error || `mem_search_${r.status}` };
    }
    return { results: j.results || [], mode: j.mode || "unknown" };
  } catch (e) {
    return { results: [], mode: "error", error: String(e && e.message || e) };
  }
}

function summarizeMemories(mems, cap = 5) {
  if (!Array.isArray(mems) || mems.length === 0) return "";
  const top = mems.slice(0, cap);
  const lines = top.map((m, i) => {
    const t = (m.tags && m.tags.length) ? ` [tags: ${m.tags.slice(0,3).join(", ")}]` : "";
    return `• ${m.summary}${t}`;
  });
  return lines.join("\n");
}

function recallQueryFromMessage(message) {
  // super light heuristic: if user asks "what did I say / what do you know"
  const m = (message || "").toLowerCase();
  if (
    m.includes("what did i say") ||
    m.includes("what do you know") ||
    m.includes("remember") ||
    m.includes("recall")
  ) {
    return ""; // force recent_fallback path for broad recall
  }
  // Otherwise try to use the user’s message as the semantic-ish query (text ilike in our fn)
  return message || "";
}

async function callOpenAI({ system, user, model, temperature, maxTokens }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const body = {
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature:
      process.env.OPENAI_INCLUDE_TEMPERATURE === "1"
        ? Number(process.env.OPENAI_TEMPERATURE || 0.3)
        : (typeof temperature === "number" ? temperature : 0.3),
    max_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || maxTokens || 300),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const rsp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await rsp.json();
  if (!rsp.ok) {
    const msg = json?.error?.message || `openai_${rsp.status}`;
    throw new Error(msg);
  }
  const text = json?.choices?.[0]?.message?.content?.trim() || "";
  return text;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return ok({ ok: true });
    if (event.httpMethod !== "POST") return bad(405, { error: "method_not_allowed" });

    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return ok({ error: "bad_json" });
    }

    const message = (payload.message || "").toString();
    const userId = payload.userId || payload.user_id || "";
    if (!message) return ok({ error: "missing_message" });

    // Memory lookup (semantic-ish text search or recent fallback)
    let memoriesUsed = [];
    let memMode = "unknown";

    if (userId) {
      const query = recallQueryFromMessage(message);
      const { results, mode } = await fetchMemories({ userId, query, limit: 5 });
      memoriesUsed = results || [];
      memMode = mode || "unknown";
    }

    const memDigest = summarizeMemories(memoriesUsed, 5);

    const systemPrompt = `
You are Keilani: warm, concise, helpful, and adaptive. Keep replies clear and human.
If user memories are provided, incorporate them naturally without over-stating certainty.

USER MEMORIES (if any):
${memDigest || "(none)"} 

Guidelines:
- If a memory seems relevant, acknowledge it briefly (e.g., "I remember you like synthwave").
- Do not invent personal facts.
- If no relevant memories, proceed normally.
`;

    const reply = await callOpenAI({
      system: systemPrompt,
      user: message,
    });

    return ok({
      version: "chat-mem-v3.2",
      reply,
      memCount: memoriesUsed.length,
      memMode,
      memoriesUsed,
    });
  } catch (e) {
    return ok({ error: "server_error", detail: String(e && e.message || e) });
  }
};
