// netlify/functions/chat.js
// Chat with memory fetch + opt-in auto-upsert (v3.3). CommonJS for Netlify.

// -------------------- tiny helpers --------------------
const ok = (body, extraHeaders = {}) => ({
  statusCode: 200,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
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
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

function baseUrl() {
  return (
    process.env.URL ||
    process.env.DEPLOY_URL ||
    process.env.DEPLOY_PRIME_URL ||
    "http://localhost:8888"
  );
}

// -------------------- memory I/O --------------------
async function fetchMemories({ userId, query, limit = 5 }) {
  try {
    const r = await fetch(`${baseUrl()}/.netlify/functions/memory-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, query, limit }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) {
      return { results: [], mode: "error", error: j?.error || `mem_search_${r.status}` };
    }
    return { results: j.results || [], mode: j.mode || "unknown" };
  } catch (e) {
    return { results: [], mode: "error", error: String(e?.message || e) };
  }
}

async function upsertMemory({ userId, summary, importance = 1, tags }) {
  try {
    const r = await fetch(`${baseUrl()}/.netlify/functions/memory-upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, summary, importance, tags }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) return { ok: false, error: j?.error || `mem_upsert_${r.status}` };
    return { ok: true, id: j.id, created_at: j.created_at };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function summarizeMemories(mems, cap = 5) {
  if (!Array.isArray(mems) || mems.length === 0) return "";
  const top = mems.slice(0, cap);
  const lines = top.map((m) => {
    const t = (m.tags && m.tags.length) ? ` [tags: ${m.tags.slice(0,3).join(", ")}]` : "";
    return `• ${m.summary}${t}`;
  });
  return lines.join("\n");
}

function recallQueryFromMessage(message) {
  const m = (message || "").toLowerCase();
  if (
    m.includes("what did i say") ||
    m.includes("what do you know") ||
    m.includes("remember") ||
    m.includes("recall")
  ) {
    // broad recall → prefer recent fallback via memory-search function
    return "";
  }
  return message || "";
}

// -------------------- auto-extract / auto-save (explicit-only) --------------------
// Only saves when the user *explicitly* asks to remember.
function maybeExtractExplicitMemory(message) {
  if (!message) return null;
  const txt = String(message).trim();

  // Normalize whitespace/smart quotes a bit
  const msg = txt.replace(/\s+/g, " ").trim();

  // Examples it catches:
  // "remember that I like synthwave"
  // "remember: my favorite game is Hades"
  // "note that I'm in Austin"
  // "save this: my birthday is July 3"
  const explicit = /^(?:please\s+)?(?:remember|remember that|note that|save this)\b[:\s]+(.+?)$/i.exec(msg);
  if (explicit && explicit[1]) {
    const raw = explicit[1].trim();
    if (raw.length < 6 || raw.length > 300) return null;
    return {
      summary: raw,
      tags: guessTags(raw),
      importance: 1,
      reason: "explicit",
    };
  }

  return null;
}

// tiny tag guesser (super light)
function guessTags(s) {
  const t = [];
  const L = s.toLowerCase();
  if (/(music|song|artist|band|synthwave|hip hop|rock|edm|jazz)/.test(L)) t.push("music");
  if (/(game|gaming|xbox|playstation|steam|nintendo|hades)/.test(L)) t.push("gaming");
  if (/(city|state|country|live in|from|austin|nyc|la|london)/.test(L)) t.push("location");
  if (/(birthday|born|age)/.test(L)) t.push("life");
  if (/(work|job|company|startup|business)/.test(L)) t.push("work");
  return t.slice(0, 3);
}

// fire-and-forget with timeout so we never block the reply
async function upsertMemoryNonBlocking(args, timeoutMs = 900) {
  const t = new Promise((_, rej) => setTimeout(() => rej(new Error("mem_upsert_timeout")), timeoutMs));
  try {
    return await Promise.race([upsertMemory(args), t]);
  } catch {
    return { ok: false, error: "mem_upsert_timeout" };
  }
}

// -------------------- OpenAI --------------------
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

// -------------------- handler --------------------
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
    const userId = payload.userId || payload.user_id || ""; // accept both
    if (!message) return ok({ error: "missing_message" });

    // 1) Fetch memories (semantic-ish or recent fallback)
    let memoriesUsed = [];
    let memMode = "unknown";
    if (userId) {
      const query = recallQueryFromMessage(message);
      const { results, mode } = await fetchMemories({ userId, query, limit: 5 });
      memoriesUsed = results || [];
      memMode = mode || "unknown";
    }

    const memDigest = summarizeMemories(memoriesUsed, 5);

    // 2) Build system prompt
    const systemPrompt = `
You are Keilani: warm, concise, helpful, and adaptive. Keep replies clear and human.
If user memories are provided, incorporate them naturally and briefly. Do not invent facts.

USER MEMORIES (if any):
${memDigest || "(none)"}

Guidelines:
- If a memory is relevant, acknowledge it lightly (e.g., "I remember you like synthwave").
- If none apply, proceed normally.
`.trim();

    // 3) Answer
    const reply = await callOpenAI({ system: systemPrompt, user: message });

    // 4) Optional auto-upsert (explicit-only)
    let memSaved = null;
    let memCandidate = null;
    if (process.env.MEM_AUTO === "1" && userId) {
      memCandidate = maybeExtractExplicitMemory(message);
      if (memCandidate && memCandidate.summary) {
        // basic dedupe guard: don't save exact duplicate of the recent 5 we just fetched
        const exists = memoriesUsed.some(
          (m) => (m.summary || "").trim().toLowerCase() === memCandidate.summary.trim().toLowerCase()
        );
        if (!exists) {
          memSaved = await upsertMemoryNonBlocking({
            userId,
            summary: memCandidate.summary,
            importance: memCandidate.importance || 1,
            tags: memCandidate.tags || [],
          });
        } else {
          memSaved = { ok: true, skipped: "duplicate_recent" };
        }
      }
    }

    // 5) Respond with telemetry for easy debugging
    return ok({
      version: "chat-mem-v3.3",
      reply,
      memCount: memoriesUsed.length,
      memMode,
      memoriesUsed,
      memAuto: process.env.MEM_AUTO === "1" ? "on" : "off",
      memExtracted: memCandidate || null,
      memSaved: memSaved || null,
    });
  } catch (e) {
    return ok({ error: "server_error", detail: String(e?.message || e) });
  }
};
