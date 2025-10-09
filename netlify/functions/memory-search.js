// CommonJS
const { createClient } = require("@supabase/supabase-js");

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
      model: "text-embedding-3-small",
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
    const query = body.query || body.q || "";
    const limit = Math.min(Math.max(parseInt(body.limit || 5, 10), 1), 50);

    if (!userId) return res(200, { error: "missing_fields", need: ["userId"], got: Object.keys(body) });

    // Do we have *any* vectors for this user?
    const { data: counts, error: cntErr } = await client
      .from("memories")
      .select("count:count(embedding)")
      .eq("user_id", userId);

    const withVec = counts && counts[0] && Number(counts[0].count) > 0;

    // If we can, try vector search via RPC; otherwise fallback to text trgm search
    if (withVec && query.trim()) {
      try {
        const v = await embed(query.trim());
        const { data, error } = await client.rpc("match_memories", {
          p_user_id: userId,
          p_query_embedding: v,
          p_match_count: limit,
          p_min_score: 0.05
        });

        if (!error && Array.isArray(data)) {
          return res(200, {
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
          });
        }
        // If RPC failed for any reason, fall back to text
        if (error) console.error("[memory-search] rpc error:", error);
      } catch (e) {
        console.error("[memory-search] embed fail, fallback to text:", e.message);
      }
    }

    // Text fallback (trgm if available, else ILIKE)
    let q = client.from("memories").select("id, summary, tags, importance, created_at")
      .eq("user_id", userId)
      .limit(limit);

    if (query) {
      // prefer trgm operator with ilike-ish behavior
      q = q.textSearch ? q.textSearch("summary", query) : q.ilike("summary", `%${query}%`);
    }

    const { data: rows, error } = await q;
    if (error) {
      console.error("[memory-search] text query error:", error);
      return res(500, { ok: false, error: "db_query_failed", detail: error.message });
    }

    return res(200, { ok: true, mode: "text", count: rows.length, results: rows });
  } catch (e) {
    console.error("[memory-search] fatal:", e);
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
