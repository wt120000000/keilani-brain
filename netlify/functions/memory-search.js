// netlify/functions/memory-search.js
// POST { user_id: string, query: string, limit?: number }
// -> { matches: [{ id, content, similarity }] }

const { createClient } = require("@supabase/supabase-js");

/* ---------- helpers ---------- */
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

/* ---------- main ---------- */
exports.handler = async (event) => {
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
  const query = String(body.query || "").trim();
  const limit = Math.max(1, Math.min(50, Number(body.limit || 8)));
  if (!user_id || !query) {
    return json(400, { error: "missing_fields", detail: "user_id and query are required" });
  }

  // 1) Embed the query
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
        input: query,
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

  // 2) RPC search (search_memories_api expects float8[] → vector(1536))
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.rpc("search_memories_api", {
    p_user: user_id,
    p_query: vector, // supabase-js sends as float8[] just fine
    p_limit: limit,
  });

  if (error) return json(500, { error: "search_failed", detail: error.message });
  return json(200, { matches: data || [] });
};
