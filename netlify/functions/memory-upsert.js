// CommonJS
const { createClient } = require("@supabase/supabase-js");

// pick either SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_SERVICE ||
    process.env.SUPABASE_KEY;
  if (!url || !key) {
    return { error: { message: "server_not_configured", missing: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE"] } };
  }
  return { client: createClient(url, key, { auth: { persistSession: false } }) };
}

async function embed(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "text-embedding-3-small", // 1536-dim
      input: text
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai_embed_failed: ${res.status} ${body}`);
  }

  const json = await res.json();
  const vec = json?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error("openai_embed_no_vector");
  return vec;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: cors(), body: "" };
    }
    if (event.httpMethod !== "POST") {
      return res(405, { error: "method_not_allowed" });
    }

    const { client, error: cfgErr } = getSupabase();
    if (cfgErr) return res(500, cfgErr);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return res(400, { error: "invalid_json" });
    }

    const userId = body.user_id || body.userId;
    const summary = body.summary || body.text;
    const importance = Number(body.importance || 1);
    const tags = Array.isArray(body.tags) ? body.tags : null;

    if (!userId || !summary) {
      return res(200, { error: "missing_fields", need: ["userId","text"], got: Object.keys(body) });
    }

    // Get embedding (best effort: if it fails, still insert but without vector)
    let vec = null;
    try {
      vec = await embed(summary);
    } catch (e) {
      // log but don’t fail the write
      console.error("[memory-upsert] embed failed:", e.message);
    }

    const insert = {
      user_id: userId,
      summary,
      importance,
      tags
    };
    if (vec) insert.embedding = vec; // pgvector accepts number[] directly

    const { data, error } = await client
      .from("memories")
      .insert(insert)
      .select("id, created_at")
      .single();

    if (error) {
      console.error("[memory-upsert] supabase insert error:", error);
      return res(500, { error: "db_insert_failed", detail: error.message });
    }

    return res(200, { ok: true, id: data.id, created_at: data.created_at });
  } catch (e) {
    console.error("[memory-upsert] fatal:", e);
    return res(500, { error: "unexpected", detail: String(e.message || e) });
  }
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function res(statusCode, obj) {
  return { statusCode, headers: cors(), body: JSON.stringify(obj) };
}
