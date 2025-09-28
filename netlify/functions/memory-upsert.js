// netlify/functions/memory-upsert.js
// POST { user_id: string, content: string }
// -> { id, user_id, content }

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

/* ---------- tiny helpers ---------- */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function requireEnv() {
  // Your Netlify variable names:
  //  - SUPABASE_URL
  //  - SUPABASE_SERVICE_ROLE
  //  - OPENAI_API_KEY
  // Also accept legacy names to be safe.
  const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_URI ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const SUPABASE_SERVICE_ROLE =
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  const OPENAI_API_KEY =
    process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE || !OPENAI_API_KEY) {
    return { ok: false, error: "missing_supabase_env" };
  }
  return { ok: true, SUPABASE_URL, SUPABASE_SERVICE_ROLE, OPENAI_API_KEY };
}

/* ---------- main handler ---------- */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const env = requireEnv();
  if (!env.ok) return json(500, { error: "missing_supabase_env" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "invalid_json", detail: String(e.message || e) });
  }

  const user_id = String(body.user_id || "").trim();
  const content = String(body.content || "").trim();
  if (!user_id || !content) {
    return json(400, { error: "missing_fields", detail: "user_id and content are required" });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 1) Upsert into memory (dedupe by (user_id, sha256(content)))
  const dedup_hash = crypto.createHash("sha256").update(content).digest("hex");
  const insertRow = { user_id, content, dedup_hash };

  // Upsert with unique (user_id, dedup_hash) index we created earlier
  const { data: mem, error: memErr } = await supabase
    .from("memory")
    .upsert(insertRow, { onConflict: "user_id,dedup_hash" })
    .select("id, user_id, content")
    .single();

  if (memErr) return json(500, { error: "memory_upsert_failed", detail: memErr.message });

  // 2) Get embedding from OpenAI (text-embedding-3-small → 1536 dims)
  let vector;
  try {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: content,
      }),
    });
    const j = await resp.json();
    if (!resp.ok) return json(resp.status, { error: "openai_embed_error", detail: j });
    vector = j?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== 1536) {
      return json(500, { error: "bad_embedding_shape", detail: { length: vector?.length } });
    }
  } catch (e) {
    return json(502, { error: "embed_exception", detail: String(e.message || e) });
  }

  // 3) Upsert into memory_embed
  const { error: embErr } = await supabase
    .from("memory_embed")
    .upsert({ memory_id: mem.id, embedding: vector, model: "text-embedding-3-small" });

  if (embErr) return json(500, { error: "embed_upsert_failed", detail: embErr.message });

  return json(200, mem);
};
