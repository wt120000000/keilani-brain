// netlify/functions/chat.js
// Keilani chat endpoint: CORS, entitlements, burst rate-limit, RAG, persistence.

const { getEntitlements, bumpUsage, saveMessages } = require("./_entitlements.js");
const { createClient } = require("@supabase/supabase-js");

// ---------- CORS allowlist ----------
// Accepts either CORS_ALLOWED_ORIGINS or ALLOWED_ORIGINS (space/comma separated)
const RAW_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ||
  process.env.ALLOWED_ORIGINS ||
  ""
).replace(/\s+/g, ",");
const ALLOWLIST = RAW_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
function corsHeaders(origin = "") {
  const allowOrigin = ALLOWLIST.includes(origin) ? origin : (ALLOWLIST[0] || "*");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-User-Id,x-user-id",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8"
  };
}
function json(status, origin, obj) { return { statusCode: status, headers: corsHeaders(origin), body: JSON.stringify(obj) }; }

// ---------- Supabase (server-side only) ----------
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE;
const sb = (SUPA_URL && SUPA_KEY)
  ? createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })
  : null;

// ---------- Model config ----------
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---------- Burst rate-limit (per minute) ----------
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 15);

// In-memory fallback (best-effort across a single lambda instance)
const localBuckets = new Map();
function localCheckRate(userId) {
  const now = Date.now();
  const windowMs = 60_000;
  const arr = localBuckets.get(userId) || [];
  const fresh = arr.filter(t => now - t < windowMs);
  if (fresh.length >= RATE_LIMIT_PER_MIN) return false;
  fresh.push(now);
  localBuckets.set(userId, fresh);
  return true;
}

// ---------- Helpers ----------
async function embedText(text, model = "text-embedding-3-small") {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text })
  });
  if (!r.ok) throw new Error(await r.text());
  const d = await r.json();
  return d?.data?.[0]?.embedding;
}

function buildSystem(role, ctx) {
  const byRole = {
    COMPANION: "You are Keilani: playful, kind, supportive. Keep replies short and warm.",
    MENTOR:    "You are Keilani: practical, compassionate coach. No medical/legal advice.",
    GAMER:     "You are Keilani: hype gamer friend and coach. Be energetic and tactical.",
    CREATOR:   "You are Keilani: creative strategist; suggest hooks, formats, and trends.",
    POLYGLOT:  "You are Keilani: language buddy; be encouraging and correct gently.",
    CUSTOM:    "You are Keilani: use the user's saved preferences to mirror their style."
  };
  const base = byRole[role] || byRole.COMPANION;
  if (!ctx) return base;
  return base + " When helpful, ground answers in the Context below. If context is irrelevant, answer normally.\n\nCONTEXT:\n" + ctx;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, origin, { error: "method_not_allowed" });
  }

  if (!OPENAI_KEY) return json(500, origin, { error: "openai_key_missing" });

  try {
    // ---------- Auth ----------
    const userId = event.headers["x-user-id"] || event.headers["X-User-Id"];
    if (!userId) return json(401, origin, { error: "unauthorized" });

    // ---------- Body ----------
    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, origin, { error: "invalid_json" }); }

    const role = String(body.role || "COMPANION").toUpperCase();
    const model = String(body.model || DEFAULT_MODEL);

    let messages = Array.isArray(body.messages) ? body.messages : null;
    const single = typeof body.message === "string" ? body.message.trim() : "";
    if (!messages) {
      if (!single) return json(400, origin, { error: "message_required" });
      messages = [{ role: "user", content: single }];
    }

    // ---------- Burst rate-limit (prefer Supabase, else local) ----------
    if (sb) {
      try {
        const sinceIso = new Date(Date.now() - 60_000).toISOString();
        const { count, error } = await sb
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId).eq("role", "user").gte("created_at", sinceIso);
        if (error) throw error;
        if ((count || 0) >= RATE_LIMIT_PER_MIN) {
          return json(429, origin, { error: "rate_limited", window: "60s", limit: RATE_LIMIT_PER_MIN });
        }
      } catch (e) {
        // fall back to local limiter if db check fails
        if (!localCheckRate(userId)) {
          return json(429, origin, { error: "rate_limited", window: "60s", limit: RATE_LIMIT_PER_MIN, note: "local" });
        }
      }
    } else {
      if (!localCheckRate(userId)) {
        return json(429, origin, { error: "rate_limited", window: "60s", limit: RATE_LIMIT_PER_MIN, note: "local" });
      }
    }

    // ---------- Daily entitlement ----------
    const { ent, usage } = await getEntitlements(userId);
    const maxMsgs = Number(ent.max_messages_per_day || 30);
    if ((usage.messages_used || 0) >= maxMsgs) {
      return json(402, origin, { error: "limit_reached", upgrade: true });
    }

    // ---------- RAG retrieval (optional) ----------
    let ragUsed = false, ragHits = 0, sources = [];
    let context = "";
    if (sb && body.rag !== false) {
      try {
        // Use the last user utterance for retrieval
        const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
        if (lastUser) {
          const qEmb = await embedText(lastUser);
          // Prefer RPC if present
          let hits = [];
          try {
            const { data } = await sb.rpc("match_kb", {
              query_embedding: qEmb,
              match_count: body.rag_count ?? 5,
              similarity_threshold: body.rag_threshold ?? 0.70
            });
            hits = data || [];
          } catch (rpcErr) {
            // RPC not available; skip quietly
            console.error("RAG RPC error:", rpcErr?.message || rpcErr);
          }
          if (Array.isArray(hits) && hits.length) {
            ragUsed = true;
            ragHits = hits.length;
            sources = hits.map(h => ({ title: h.title, source: h.source, score: h.similarity || h.score }));
            context = hits.map(h => `Source: ${h.source}\n${h.chunk}`).join("\n---\n");
          }
        }
      } catch (e) {
        console.error("RAG retrieval failed:", e?.message || e);
      }
    }

    // ---------- Compose messages for OpenAI ----------
    const system = buildSystem(role, context);
    const payload = {
      model,
      temperature: body.temperature ?? 0.8,
      max_tokens: body.max_tokens ?? 400,
      messages: [{ role: "system", content: system }, ...messages]
    };

    // ---------- Call OpenAI ----------
    const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    let data;
    try { data = await oaRes.json(); } catch { data = null; }
    if (!oaRes.ok) return json(oaRes.status, origin, { error: "openai_error", detail: data || (await oaRes.text().catch(() => "")) });

    const reply = data?.choices?.[0]?.message?.content?.trim() || "…";

    // ---------- Persistence (best-effort) ----------
    try {
      await saveMessages?.(userId, [
        ...messages.map(m => ({ role: m.role, content: m.content })),
        { role: "assistant", content: reply }
      ]);
    } catch (e) { console.error("saveMessages failed:", e); }

    // ---------- Usage bump (daily counter) ----------
    try { await bumpUsage(userId, { messages: 1 }); }
    catch (e) { console.error("bumpUsage failed:", e); }

    // ---------- Done ----------
    return json(200, origin, { ok: true, reply, model, usage: data?.usage, rag: { used: ragUsed, hits: ragHits, sources } });

  } catch (e) {
    return json(500, origin, { error: "server_error", detail: String(e?.message || e) });
  }
};
