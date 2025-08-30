// netlify/functions/chat.js
// Chat endpoint for Keilani: robust CORS, messages[], optional RAG (kb_chunks), optional message persistence.

const { getEntitlements } = require("./_entitlements.js");
const { createClient } = require("@supabase/supabase-js");

// ---- CORS allowlist (spaces or commas). Also auto-allow framer domains. Tolerant to null origins.
const RAW = (
  process.env.ALLOWED_ORIGINS ||
  process.env.cors_allowed_origins ||
  process.env.CORS_ALLOWED_ORIGINS ||
  ""
).replace(/\s+/g, ",");
const ALLOWLIST = RAW.split(",").map(s => s.trim()).filter(Boolean);

function corsHeaders(origin = "") {
  const o = (origin || "").toLowerCase();
  const okList = ALLOWLIST.map(s => s.toLowerCase());
  const isAllowed = okList.includes(o);
  const isFramer = /^https:\/\/([a-z0-9-]+\.)?(framer\.com|framerusercontent\.com|framerstatic\.com)$/.test(o);

  let allowOrigin;
  if (isAllowed || isFramer) allowOrigin = origin;
  else if (!origin || origin === "null") allowOrigin = "*";
  else allowOrigin = ALLOWLIST[0] || "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-User-Id,x-user-id",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8"
  };
}
const json = (code, origin, obj) => ({ statusCode: code, headers: corsHeaders(origin), body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  // Preflight
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(origin), body: "" };
  if (event.httpMethod !== "POST") return json(405, origin, { error: "method_not_allowed" });

  try {
    // Auth
    const userId = event.headers["x-user-id"] || event.headers["X-User-Id"];
    if (!userId) return json(401, origin, { error: "unauthorized" });

    // Body
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, origin, { error: "invalid_json" }); }

    // Accept messages[] or message
    const singleMessage = typeof body.message === "string" ? body.message.trim() : "";
    let messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages) {
      if (!singleMessage) return json(400, origin, { error: "message_required" });
      messages = [{ role: "user", content: singleMessage }];
    }

    // Role/system
    const role = String(body.role || "COMPANION").toUpperCase();
    const systemByRole = {
      COMPANION: "You are Keilani: playful, kind, supportive. Keep replies short and warm.",
      MENTOR:   "You are Keilani: practical, compassionate coach. No medical/legal advice.",
      GAMER:    "You are Keilani: hype gamer friend and coach. Be energetic and tactical.",
      CREATOR:  "You are Keilani: creative strategist; suggest hooks, formats, and trends.",
      POLYGLOT: "You are Keilani: language buddy; be encouraging and correct gently.",
      CUSTOM:   "You are Keilani: use the user's saved preferences to mirror their style."
    };
    const baseSystem = body.system || systemByRole[role] || systemByRole.COMPANION;

    // Entitlements
    const { ent, usage } = await getEntitlements(userId).catch(() => ({ ent: { max_messages_per_day: 30 }, usage: { messages_used: 0 } }));
    const maxMsgs = Number(ent.max_messages_per_day || 30);
    if ((usage.messages_used || 0) >= maxMsgs) {
      return json(402, origin, { error: "limit_reached", upgrade: true });
    }

    // OpenAI config
    const key = process.env.OPENAI_API_KEY;
    const model = body.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (!key) return json(500, origin, { error: "openai_error", detail: "OPENAI_API_KEY missing" });

    // ---- Optional RAG (Supabase kb_chunks + RPC function match_kb_chunks)
    let system = baseSystem;
    const supaReady = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE);
    if (supaReady) {
      try {
        const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
        const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
        if (lastUser) {
          const embRes = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "text-embedding-3-small", input: lastUser })
          });
          const embData = await embRes.json();
          const qvec = embData?.data?.[0]?.embedding;
          if (qvec) {
            const { data: hits, error } = await supa.rpc("match_kb_chunks", { query_embedding: qvec, match_count: 6 });
            if (!error && hits?.length) {
              const ctx = hits.map((h, i) => `(${i + 1}) ${h.chunk}`).join("\n\n");
              system = `${baseSystem}\n\nUse the following CONTEXT if relevant. If it conflicts, prefer the context.\n\n${ctx}`;
            }
          }
        }
      } catch (e) {
        // If retrieval fails, continue without RAG
        console.error("RAG retrieval failed:", e?.message || e);
      }
    }

    // OpenAI call
    const payload = {
      model,
      temperature: body.temperature ?? 0.8,
      max_tokens: body.max_tokens ?? 400,
      messages: [{ role: "system", content: system }, ...messages]
    };

    const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    let data; try { data = await oaRes.json(); } catch { data = null; }
    if (!oaRes.ok) return json(oaRes.status, origin, { error: "openai_error", detail: data || (await oaRes.text().catch(() => "")) });

    const reply = data?.choices?.[0]?.message?.content?.trim() || "…";

    // Optional: persist last user + assistant message
    if (supaReady) {
      try {
        const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        const rows = [];
        if (lastUser?.content) rows.push({ user_id: userId, role: "user", content: lastUser.content });
        rows.push({ user_id: userId, role: "assistant", content: reply });
        if (rows.length) await supa.from("messages").insert(rows);
      } catch (e) {
        console.error("save messages failed:", e?.message || e);
      }
    }

    return json(200, origin, { ok: true, reply, model, usage: data?.usage });
  } catch (e) {
    return json(500, origin, { error: "server_error", detail: String(e?.message || e) });
  }
};
