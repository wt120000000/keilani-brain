// netlify/functions/chat.js
// Chat endpoint for Keilani — robust CORS, OPTIONS preflight, messages[] support, entitlements.

const { getEntitlements, bumpUsage } = require("./_entitlements.js");

// --- CORS allowlist: supports ALLOWED_ORIGINS or cors_allowed_origins,
// values separated by spaces OR commas.
const RAW_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  process.env.cors_allowed_origins ||
  ""
).replace(/\s+/g, ","); // convert any whitespace into commas

const ALLOWLIST = RAW_ORIGINS
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

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

function json(statusCode, origin, obj) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: JSON.stringify(obj)
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  // --- Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(origin), body: "" };
  }

  // --- Method guard
  if (event.httpMethod !== "POST") {
    return json(405, origin, { error: "method_not_allowed" });
  }

  try {
    // --- Auth: user id header
    const userId = event.headers["x-user-id"] || event.headers["X-User-Id"];
    if (!userId) {
      return json(401, origin, { error: "unauthorized" });
    }

    // --- Parse body
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, origin, { error: "invalid_json" });
    }

    // Accept either `messages` (array of {role, content}) or `message` (string)
    const singleMessage = typeof body.message === "string" ? body.message.trim() : "";
    let messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages) {
      if (!singleMessage) return json(400, origin, { error: "message_required" });
      messages = [{ role: "user", content: singleMessage }];
    }

    // Role → system prompt (allow override via body.system)
    const role = String(body.role || "COMPANION").toUpperCase();
    const systemByRole = {
      COMPANION: "You are Keilani: playful, kind, supportive. Keep replies short and warm.",
      MENTOR:   "You are Keilani: practical, compassionate coach. No medical/legal advice.",
      GAMER:    "You are Keilani: hype gamer friend and coach. Be energetic and tactical.",
      CREATOR:  "You are Keilani: creative strategist; suggest hooks, formats, and trends.",
      POLYGLOT: "You are Keilani: language buddy; be encouraging and correct gently.",
      CUSTOM:   "You are Keilani: use the user's saved preferences to mirror their style."
    };
    const system = body.system || systemByRole[role] || systemByRole.COMPANION;

    // --- Entitlements / usage limit
    const { ent, usage } = await getEntitlements(userId);
    const maxMsgs = Number(ent.max_messages_per_day || 30);
    if ((usage.messages_used || 0) >= maxMsgs) {
      return json(402, origin, { error: "limit_reached", upgrade: true });
    }

    // --- OpenAI config
    const model = body.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return json(500, origin, { error: "openai_error", detail: "OPENAI_API_KEY missing" });
    }

    const payload = {
      model,
      temperature: body.temperature ?? 0.8,
      max_tokens: body.max_tokens ?? 400,
      messages: [{ role: "system", content: system }, ...messages]
    };

    // --- OpenAI call
    const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    let data;
    try {
      data = await oaRes.json();
    } catch {
      data = null;
    }

    if (!oaRes.ok) {
      return json(oaRes.status, origin, { error: "openai_error", detail: data || (await oaRes.text().catch(() => "")) });
    }

    const reply = data?.choices?.[0]?.message?.content?.trim() || "…";

    // --- Bump usage
    try {
      await bumpUsage(userId, { messages: 1 });
    } catch (e) {
      console.error("bumpUsage failed:", e);
    }

    // --- Success
    return json(200, origin, {
      ok: true,
      reply,
      model,
      usage: data?.usage
    });

  } catch (e) {
    return json(500, origin, { error: "server_error", detail: String(e?.message || e) });
  }
};
