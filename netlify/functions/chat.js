// netlify/functions/chat.js
// CJS Netlify Function — memory-aware chat (v3.4)

const fetch = global.fetch || require("node-fetch");

// ----- Config helpers --------------------------------------------------------
const NODE = process.version;
const {
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_TEMPERATURE,
  OPENAI_INCLUDE_TEMPERATURE,
  OPENAI_MAX_OUTPUT_TOKENS,
  MEM_AUTO, // "1" enables explicit autosave on "remember that ..."
  LOG_LEVEL = "info",
} = process.env;

const asBool = (v) => (typeof v === "string" ? v === "1" || v.toLowerCase() === "true" : !!v);
const log = (level, ...args) => {
  const order = ["error", "warn", "info", "debug", "trace"];
  if (order.indexOf(level) <= order.indexOf((LOG_LEVEL || "info").toLowerCase())) {
     
    console[level](...args);
  }
};

// Build a same-origin Functions URL (works on custom domain & unique deploy URLs)
function fnUrl(event, name) {
  const host = event.headers["x-forwarded-host"] || event.headers.host;
  const proto = (event.headers["x-forwarded-proto"] || "https");
  return `${proto}://${host}/.netlify/functions/${name}`;
}

// Minimal JSON response helper
function json(status, body, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// ----- Memory search + (optional) autosave -----------------------------------
async function searchMemories(event, userId, query, limit = 8) {
  const url = fnUrl(event, "memory-search");
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ user_id: userId, query, limit }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`memory-search failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function upsertMemory(event, payload) {
  const url = fnUrl(event, "memory-upsert");
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`memory-upsert failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Extract a “remember that …” statement (very simple heuristic)
function extractExplicitMemory(message) {
  // examples:
  // "remember that my favorite game is Hades."
  // "Remember, I'm vegetarian."
  const m =
    message.match(/\bremember(?:\s+that)?\s+(.*?)(?:\.*\s*)$/i);
  if (!m) return null;

  let summary = m[1].trim();
  // Avoid saving empty or obviously non-fact text
  if (!summary || summary.length < 3) return null;

  // Clean trailing quotes/period spam
  summary = summary.replace(/["“”]+/g, "").replace(/\s*\.+$/, "").trim();
  return summary;
}

// ----- Prompt construction ----------------------------------------------------
function buildSystemPrompt(userFacts) {
  const factsBlock =
    userFacts && userFacts.length
      ? `Known facts about this user (from long-term memory):\n${userFacts
          .map((f, i) => `- ${f.summary}`)
          .join("\n")}\n\n`
      : "";

  return [
    "You are Keilani — warm, playful, quick, and adaptive.",
    "Priorities:",
    "1) Be concise but engaging. 2) Use the user's known preferences when helpful.",
    "3) If you reference a known fact, weave it naturally (don't sound robotic).",
    "",
    factsBlock,
    "If user asks for recommendations, bias toward their known preferences.",
  ].join("\n");
}

// ----- OpenAI call ------------------------------------------------------------
async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const url = "https://api.openai.com/v1/chat/completions";

  const body = {
    model: OPENAI_MODEL,
    messages,
  };

  if (asBool(OPENAI_INCLUDE_TEMPERATURE) && OPENAI_TEMPERATURE) {
    body.temperature = Number(OPENAI_TEMPERATURE);
  }
  if (OPENAI_MAX_OUTPUT_TOKENS) {
    // new param name on some models; fallback to max_tokens
    body.max_output_tokens = Number(OPENAI_MAX_OUTPUT_TOKENS);
    body.max_tokens = Number(OPENAI_MAX_OUTPUT_TOKENS);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI error: ${res.status} ${text}`);
  }
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim() || "";
  return reply;
}

// ----- Handler ---------------------------------------------------------------
exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(200, { ok: true });
    }
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const body = JSON.parse(event.body || "{}");
    const { message, userId } = body;

    if (!message || !userId) {
      return json(400, { error: "Missing message or userId" });
    }

    // 1) Look up memories related to the message
    let memCount = 0;
    let memMode = "unknown";
    let memoriesUsed = [];
    try {
      const mem = await searchMemories(event, userId, message, 8);
      memCount = Number(mem.count || 0);
      memMode = mem.mode || "unknown";
      memoriesUsed = (mem.results || []).map((r) => ({
        id: r.id,
        summary: r.summary,
        created_at: r.created_at,
        importance: r.importance,
        tags: r.tags || [],
      }));
    } catch (e) {
      log("warn", "memory-search error:", e.message);
    }

    // 2) Build the prompt with memory facts
    const system = buildSystemPrompt(memoriesUsed);
    const userMsg = message;

    const messages = [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ];

    // 3) If explicit autosave phrase and MEM_AUTO is on, try to save
    let memAutoStatus = asBool(MEM_AUTO) ? "on" : "off";
    let memExtracted = null;
    let memSaved = null;

    if (memAutoStatus === "on") {
      const extracted = extractExplicitMemory(message);
      if (extracted) {
        memExtracted = extracted;
        try {
          const saved = await upsertMemory(event, {
            user_id: userId,
            summary: extracted,
            importance: 1,
            tags: ["autosave"],
          });
          memSaved = { ok: true, id: saved.id, created_at: saved.created_at };
          // Also add a quick assistant “ack” hint to the prompt so model can acknowledge naturally
          messages.unshift({
            role: "system",
            content:
              "User just shared a new personal fact; it has been saved to long-term memory. If appropriate, acknowledge briefly and move on.",
          });
        } catch (e) {
          memSaved = { ok: false, error: e.message };
          log("warn", "memory-upsert error:", e.message);
        }
      }
    }

    // 4) Call OpenAI
    const reply = await callOpenAI(messages);

    // 5) Return telemetry + reply
    return json(200, {
      version: "chat-mem-v3.4",
      reply,
      memCount,
      memMode,
      memoriesUsed,
      memAuto: memAutoStatus,
      memExtracted,
      memSaved,
      node: NODE,
    });
  } catch (err) {
    log("error", "chat fatal:", err);
    return json(500, {
      error: "chat_failed",
      detail: err.message || String(err),
      version: "chat-mem-v3.4",
    });
  }
};
