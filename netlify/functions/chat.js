// netlify/functions/chat.js
// Plain JSON chat endpoint with memory-awareness.
// Version: chat-mem-v3.1 (two-pass memory fetch + explicit memory ack)

const OPENAI_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const BASE_ORIGIN = process.env.PUBLIC_BASE_URL || "https://api.keilani.ai"; // sibling Netlify functions

// Basic CORS
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return res(405, { error: "method_not_allowed" });
    }
    if (!OPENAI_API_KEY) {
      return res(500, { error: "server_not_configured", detail: "OPENAI_API_KEY missing" });
    }

    let body;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return res(400, { error: "bad_json" });
    }

    const message = (body.message || "").trim();
    const userId = (body.userId || body.user_id || "").trim(); // accept either casing
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message) {
      return res(400, { error: "missing_fields", need: ["message"] });
    }

    // ---- Memory lookup (two-pass) ----
    let memoriesUsed = [];
    let memDiag = { version: "chat-mem-v3.1", memCount: 0, memMode: "none" };

    // Pass 1: query-based search
    try {
      const memResp1 = await fetch(`${BASE_ORIGIN}/.netlify/functions/memory-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: userId || undefined,
          query: message,
          limit: 8,
        }),
      });
      const memJson1 = await memResp1.json().catch(() => ({}));
      if (memResp1.ok && memJson1?.ok) {
        memoriesUsed = Array.isArray(memJson1.results) ? memJson1.results : [];
        memDiag.memCount = memoriesUsed.length || 0;
        memDiag.memMode = memJson1.mode || "unknown";
      }
    } catch (e) {
      memDiag.memError = String(e?.message || e);
    }

    // Pass 2: if no hits, recent fallback
    if ((!memoriesUsed || memoriesUsed.length === 0) && userId) {
      try {
        const memResp2 = await fetch(`${BASE_ORIGIN}/.netlify/functions/memory-search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            recent: true,
            limitRecent: 5,
          }),
        });
        const memJson2 = await memResp2.json().catch(() => ({}));
        if (memResp2.ok && memJson2?.ok && Array.isArray(memJson2.results)) {
          memoriesUsed = memJson2.results;
          memDiag.memCount = memoriesUsed.length || 0;
          memDiag.memMode = memJson2.mode || "recent_fallback";
        }
      } catch (e) {
        memDiag.memError2 = String(e?.message || e);
      }
    }

    // ---- Build system prompt ----
    const systemPrompt = buildSystemPrompt(memoriesUsed);

    // ---- Build messages ----
    const msgs = [{ role: "system", content: systemPrompt }];

    if (history.length) {
      for (const h of history.slice(-8)) {
        if (!h || typeof h !== "object") continue;
        const r = h.role === "assistant" ? "assistant" : "user";
        const c = typeof h.content === "string" ? h.content : "";
        if (c) msgs.push({ role: r, content: c });
      }
    }

    msgs.push({ role: "user", content: message });

    // ---- Call OpenAI ----
    const oa = await fetch(`${OPENAI_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: msgs,
        temperature: process.env.OPENAI_INCLUDE_TEMPERATURE ? Number(process.env.OPENAI_TEMPERATURE || 0.7) : undefined,
        max_tokens: process.env.OPENAI_MAX_OUTPUT_TOKENS ? Number(process.env.OPENAI_MAX_OUTPUT_TOKENS) : undefined,
      }),
    });

    const j = await oa.json().catch(() => ({}));
    if (!oa.ok) {
      return res(500, {
        error: "openai_error",
        status: oa.status,
        detail: j?.error || j,
        ...memDiag,
        memoriesUsed,
      });
    }

    const reply = j?.choices?.[0]?.message?.content?.trim?.() || "";

    return res(200, {
      ...memDiag,
      reply,
      memoriesUsed: memoriesUsed.map(m => ({
        id: m.id,
        summary: m.summary,
        created_at: m.created_at,
        importance: m.importance,
        tags: m.tags || [],
      })),
    });
  } catch (err) {
    return res(500, { error: "server_error", detail: String(err?.message || err) });
  }
};

// ---------- helpers ----------

function res(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
    body: JSON.stringify(obj),
  };
}

function buildSystemPrompt(memories) {
  const lines = [];
  lines.push("You are Keilani, a friendly AI voice companion.");
  lines.push(
    "If any user memories are present, you MUST acknowledge at least one relevant memory explicitly in your first sentence, unless acknowledging it would clearly be inappropriate."
  );

  if (Array.isArray(memories) && memories.length) {
    lines.push("Known user memories (most recent first):");
    for (const m of memories) {
      const tags = Array.isArray(m.tags) && m.tags.length ? ` [tags: ${m.tags.join(", ")}]` : "";
      const imp = Number.isFinite(m.importance) ? ` (importance ${m.importance})` : "";
      lines.push(`- ${m.summary}${tags}${imp}`);
    }
  } else {
    lines.push("No prior memories matched this query. If the user asks about their preferences, invite them to share so you can remember.");
  }

  lines.push("Be concise and helpful. When acknowledging a memory, keep it natural and brief.");
  return lines.join("\n");
}
