const { createClient } = require("@supabase/supabase-js");
const { getEmbedding } = require("./lib/embeddings");

// CORS helper
function cors(headers = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...headers
  };
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const memVectorsOn = process.env.MEM_VECTORS === "1";

const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null;

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: cors(), body: "" };
    }
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: "method_not_allowed" }) };
    }

    if (!supabase) {
      return {
        statusCode: 500,
        headers: cors(),
        body: JSON.stringify({ error: "server_not_configured", missing: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE"] })
      };
    }

    let payload;
    try { payload = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "invalid_json" }) }; }

    const userId = payload.user_id || payload.userId;
    const summary = payload.summary || payload.text;
    const importance = Number(payload.importance ?? 1);
    const tags = Array.isArray(payload.tags) ? payload.tags : null;

    if (!userId || !summary) {
      return {
        statusCode: 200,
        headers: cors(),
        body: JSON.stringify({ error: "missing_fields", need: ["userId", "text"], got: Object.keys(payload) })
      };
    }

    // Insert first (so we always have the record even if embedding fails)
    const { data, error } = await supabase
      .from("memories")
      .insert([{ user_id: userId, summary, tags, importance }])
      .select("id, created_at")
      .single();

    if (error) {
      console.error("[memory-upsert] insert error", error);
      return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "db_insert_failed" }) };
    }

    // Optional: compute & store embedding
    if (memVectorsOn) {
      try {
        const vec = await getEmbedding(summary);
        if (Array.isArray(vec)) {
          const up = await supabase
            .from("memories")
            .update({ embedding: vec })
            .eq("id", data.id);

          if (up.error) console.warn("[memory-upsert] embedding update failed", up.error);
        }
      } catch (e) {
        console.warn("[memory-upsert] embedding compute failed", e);
      }
    }

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({ ok: true, id: data.id, created_at: data.created_at })
    };
  } catch (err) {
    console.error("[memory-upsert] fatal", err);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "internal_error" }) };
  }
};
