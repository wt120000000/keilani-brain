const { createClient } = require("@supabase/supabase-js");
const { getEmbedding } = require("./lib/embeddings");

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
const defaultLimit = Number(process.env.MEM_TOP_K || 5);

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
    const query = payload.query || payload.q || null;
    const limit = Math.max(1, Math.min(50, Number(payload.limit || defaultLimit)));

    if (!userId) {
      return {
        statusCode: 200,
        headers: cors(),
        body: JSON.stringify({ error: "missing_fields", need: ["userId"], got: Object.keys(payload) })
      };
    }

    // Try vector search first (if enabled & query present)
    if (memVectorsOn && query) {
      try {
        const vec = await getEmbedding(query);
        if (Array.isArray(vec)) {
          const { data, error } = await supabase
            .rpc("match_memories", {
              p_user_id: userId,
              p_query_embedding: vec,
              p_match_count: limit,
              p_min_score: 0.1
            });

          if (!error && Array.isArray(data)) {
            return {
              statusCode: 200,
              headers: cors(),
              body: JSON.stringify({
                ok: true,
                mode: "vector",
                count: data.length,
                results: data.map(r => ({
                  id: r.id,
                  summary: r.summary,
                  tags: r.tags,
                  importance: r.importance,
                  created_at: r.created_at,
                  score: r.score
                }))
              })
            };
          }
          if (error) console.warn("[memory-search] rpc error => fallback", error);
        }
      } catch (e) {
        console.warn("[memory-search] vector search failed => fallback", e);
      }
    }

    // Fallback: text search (ILIKE & trigram order)
    if (query) {
      const { data, error } = await supabase
        .from("memories")
        .select("id, summary, tags, importance, created_at")
        .eq("user_id", userId)
        .ilike("summary", `%${query}%`)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        console.error("[memory-search] text err", error);
        return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "db_text_search_failed" }) };
      }

      return {
        statusCode: 200,
        headers: cors(),
        body: JSON.stringify({ ok: true, mode: "text", count: data.length, results: data })
      };
    }

    // No query: just recent memories
    const { data, error } = await supabase
      .from("memories")
      .select("id, summary, tags, importance, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[memory-search] recent err", error);
      return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "db_recent_failed" }) };
    }

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({ ok: true, mode: "recent", count: data.length, results: data })
    };
  } catch (err) {
    console.error("[memory-search] fatal", err);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "internal_error" }) };
  }
};
