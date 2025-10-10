// netlify/functions/chat.js
"use strict";

/**
 * Chat (v3.4)
 * - Uses OpenAI Chat Completions
 * - Maps OPENAI_MAX_OUTPUT_TOKENS -> max_tokens (fixes "Unrecognized request argument: max_output_tokens")
 * - No 'node-fetch' import (Node 20+ has global fetch)
 * - Pulls memories from your own Netlify functions (memory-search / memory-upsert) with graceful fallbacks
 */

const OpenAI = require("openai");

// ---------- config helpers ----------
const VERSION = "chat-mem-v3.4";

function num(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function baseUrl() {
  // Prefer the unique deploy URL during one-off tests; fall back to main URL or your custom domain.
  const u = process.env.DEPLOY_URL || process.env.URL || "https://api.keilani.ai";
  return u.replace(/\/+$/, "");
}

function json(status, obj) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "OPTIONS, POST",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    },
    body: JSON.stringify(obj),
  };
}

// ---------- memory utilities ----------
async function searchMemories({ userId, query, limit = 5 }) {
  const url =
    process.env.MEMORY_SEARCH_URL ||
    `${baseUrl()}/.netlify/functions/memory-search`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      query,
      limit,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`memory-search failed: ${res.status} ${detail}`);
  }

  return res.json();
}

async function upsertMemory({ userId, summary, importance = 1, tags = [] }) {
  const url =
    process.env.MEMORY_UPSERT_URL ||
    `${baseUrl()}/.netlify/functions/memory-upsert`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      summary,
      importance,
      tags,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`memory-upsert failed: ${res.status} ${detail}`);
  }

  return res.json();
}

// very lightweight extractor for "Remember that ..." style messages
function extractExplicitMemory(message) {
  const m = message.trim();
  // e.g., "Remember that my favorite game is Hades."
  const startsRemember =
    /^remember(\s+that)?\b/i.test(m) || /^save\s+this\b/i.test(m);

  if (!startsRemember) return null;

  // strip "remember (that)" prefix & trailing punctuation
  const cleaned = m
    .replace(/^remember(\s+that)?\s*/i, "")
    .replace(/^save\s+this[:,]?\s*/i, "")
    .replace(/[.!?]\s*$/i, "")
    .trim();

  // basic guard
  if (!cleaned || cleaned.length < 3) return null;

  // naive tags: pick a few nouns/keywords (super simple)
  const tags = [];
  if (/music|song|synthwave|artist/i.test(cleaned)) tags.push("music");
  if (/game|hades|gaming|steam|ps5|xbox/i.test(cleaned)) tags.push("games");

  return { summary: cleaned, importance: 1, tags };
}

// ---------- main handler ----------
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed", version: VERSION });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const message = (body.message || "").toString();
    const userId = (body.userId || "").toString();

    if (!message) {
      return json(400, { error: "missing_message", version: VERSION });
    }
    if (!userId) {
      return json(400, { error: "missing_userId", version: VERSION });
    }

    const memAuto = process.env.MEM_AUTO ? "on" : "off";

    // 1) try to recall memories to ground the chat
    let memCount = 0;
    let memMode = "none";
    let memoriesUsed = [];
    let memoryContext = "";

    try {
      const mem = await searchMemories({
        userId,
        query: message,
        limit: num(process.env.MEMORY_RECALL_LIMIT, 5),
      });
      memCount = num(mem.count, 0);
      memMode = mem.mode || "unknown";
      memoriesUsed = Array.isArray(mem.results) ? mem.results : [];
      const lines = memoriesUsed.map((r) => `- ${r.summary}`);
      if (lines.length) {
        memoryContext = `Known memories about the user:\n${lines.join("\n")}`;
      }
    } catch (e) {
      memMode = "error";
    }

    // 2) build OpenAI messages (ground with memoryContext if present)
    const systemParts = [
      "You are Keilani's assistant. Be concise and clear.",
      memoryContext ? `\n${memoryContext}` : "",
      "\nIf relevant, weave helpful prior info naturally (don't over-assert).",
    ].filter(Boolean);

    const messages = [
      { role: "system", content: systemParts.join("\n") },
      { role: "user", content: message },
    ];

    // 3) OpenAI call (Chat Completions) — map OPENAI_MAX_OUTPUT_TOKENS -> max_tokens
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: num(process.env.OPENAI_MAX_OUTPUT_TOKENS, 512),
      temperature: num(process.env.OPENAI_TEMPERATURE, 0.2),
      messages,
    });

    const reply =
      resp?.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I couldn't generate a reply.";

    // 4) optional explicit autosave
    let memExtracted = null;
    let memSaved = null;
    if (memAuto === "on") {
      const candidate = extractExplicitMemory(message);
      if (candidate) {
        memExtracted = candidate;
        try {
          const saved = await upsertMemory({
            userId,
            summary: candidate.summary,
            importance: candidate.importance,
            tags: candidate.tags,
          });
          memSaved = { ok: true, id: saved?.id || null };
        } catch (err) {
          memSaved = { ok: false, error: String(err.message || err) };
        }
      }
    }

    return json(200, {
      version: VERSION,
      reply,
      memCount,
      memMode,
      memoriesUsed,
      memAuto,
      memExtracted,
      memSaved,
    });
  } catch (err) {
    return json(200, {
      error: "chat_failed",
      detail: `OpenAI error: ${String(err.message || err)}`,
      version: VERSION,
    });
  }
};
