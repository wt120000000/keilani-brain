// CommonJS version (works with your current deploy output)
const { createClient } = require("@supabase/supabase-js");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE;

const MODEL_EMBED = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small"; // 1536 dims
const MIN_SIM     = parseFloat(process.env.MEM_MIN_SIM || "0.70");              // 0.70 default
const HARD_LIMIT  = parseInt(process.env.MEM_SEARCH_LIMIT || "5", 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

async function embedText(text) {
  // OpenAI responses format: data[0].embedding (1536 floats)
  const rsp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: text,
      model: MODEL_EMBED
    })
  });

  if (!rsp.ok) {
    const t = await rsp.text();
    throw new Error(`embed error: ${rsp.status} ${t}`);
  }

  const json = await rsp.json();
  return json.data[0].embedding;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      },
      body: ""
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const user_id = body.user_id;
    const query   = (body.query || "").trim();
    const limit   = Math.min(parseInt(body.limit || HARD_LIMIT, 10), 25);

    if (!user_id || !query) {
      return json(400, { ok: false, error: "missing user_id or query" });
    }

    // Check if this user has any embeddings stored
    const { data: counts, error: cntErr } = await supabase
      .rpc("exec_sql", {
        sql: `
          select count(*) as rows, count(embedding) as rows_with_vec
          from public.memories
          where user_id = $1
        `,
        params: [user_id]
      });

    // Fallback when exec_sql helper isn’t present:
    let rows_with_vec = 0;
    if (!cntErr && Array.isArray(counts) && counts.length) {
      rows_with_vec = Number(counts[0].rows_with_vec || 0);
    } else {
      const { data: quick, error: qErr } = await supabase
        .from("memories")
        .select("id")
        .eq("user_id", user_id)
        .not("embedding", "is", null)
        .limit(1);
      if (qErr) throw qErr;
      rows_with_vec = (quick && quick.length) ? 1 : 0;
    }

    const wantVector = rows_with_vec > 0; // ← force vector path if any vectors exist

    if (wantVector) {
      // 1) Embed the query
      const qVec = await embedText(query);

      // 2) Use SQL function if present, otherwise inline SQL
      // Attempt match_memories() first:
      const { data: vecMatches, error: vecErr } = await supabase.rpc("match_memories", {
        p_user_id: user_id,
        p_query_embedding: qVec,
        p_match_count: limit,
        p_min_cosine: MIN_SIM
      });

      if (!vecErr && Array.isArray(vecMatches)) {
        return json(200, {
          ok: true,
          mode: "vector",
          count: vecMatches.length,
          results: vecMatches.map(r => ({
            id: r.id,
            summary: r.summary,
            tags: r.tags,
            importance: r.importance,
            created_at: r.created_at,
            score: r.similarity
          }))
        });
      }

      // Fallback: inline SQL (works even without the helper function)
      const { data: inline, error: inlineErr } = await supabase.rpc("exec_sql", {
        sql: `
          select id, summary, tags, importance, created_at,
                 1 - (embedding <=> $2::vector) as similarity
          from public.memories
          where user_id = $1
            and embedding is not null
          order by embedding <=> $2::vector
          limit $3
        `,
        params: [user_id, qVec, limit]
      });

      if (inlineErr) throw inlineErr;

      return json(200, {
        ok: true,
        mode: "vector",
        count: inline.length,
        results: inline.map(r => ({
          id: r.id,
          summary: r.summary,
          tags: r.tags,
          importance: r.importance,
          created_at: r.created_at,
          score: r.similarity
        }))
      });
    }

    // ---- TEXT FALLBACK (no vectors for this user) ----
    const { data, error } = await supabase
      .from("memories")
      .select("id, summary, tags, importance, created_at")
      .eq("user_id", user_id)
      .ilike("summary", `%${query}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return json(200, {
      ok: true,
      mode: "text",
      count: data.length,
      results: data
    });
  } catch (err) {
    return json(200, { ok: false, error: String(err?.message || err) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(obj)
  };
}
