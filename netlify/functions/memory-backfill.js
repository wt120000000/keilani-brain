// Batch-embed any rows with NULL embedding.
// Trigger: GET /.netlify/functions/memory-backfill?userId=<uuid>&batch=100&dryRun=1
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

async function embedMany(texts) {
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
      input: texts
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai_embed_failed: ${res.status} ${body}`);
  }
  const json = await res.json();
  return json.data.map(d => d.embedding);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: cors(), body: "" };
    }

    const { client, error: cfgErr } = getSupabase();
    if (cfgErr) return res(500, cfgErr);

    const url = new URL(event.rawUrl || `https://x${event.path}${event.queryString || ""}`);
    const userId = url.searchParams.get("userId");
    const batch = Math.min(Math.max(parseInt(url.searchParams.get("batch") || "100", 10), 1), 500);
    const dry = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dry") === "1";

    let totalUpdated = 0;
    let totalScanned = 0;

    while (true) {
      let q = client.from("memories")
        .select("id, summary")
        .is("embedding", null)
        .order("created_at", { ascending: true })
        .limit(batch);

      if (userId) q = q.eq("user_id", userId);

      const { data: rows, error } = await q;
      if (error) {
        console.error("[memory-backfill] select error:", error);
        return res(500, { error: "db_select_failed", detail: error.message });
      }
      if (!rows || rows.length === 0) break;

      totalScanned += rows.length;

      if (dry) continue;

      const texts = rows.map(r => r.summary);
      let vectors = [];
      try {
        vectors = await embedMany(texts);
      } catch (e) {
        console.error("[memory-backfill] embedMany failed:", e.message);
        // fall back to single-by-single
        for (let i = 0; i < rows.length; i++) {
          try {
            const v1 = await embedMany([rows[i].summary]);
            vectors[i] = v1[0];
          } catch (e2) {
            console.error("[memory-backfill] single embed failed for id", rows[i].id, e2.message);
            vectors[i] = null;
          }
        }
      }

      // Update one by one (safe, avoids row ordering mismatches)
      for (let i = 0; i < rows.length; i++) {
        const vec = vectors[i];
        if (!Array.isArray(vec)) continue;
        const { error: uerr } = await client
          .from("memories")
          .update({ embedding: vec })
          .eq("id", rows[i].id);

        if (!uerr) totalUpdated += 1;
        else console.error("[memory-backfill] update error:", rows[i].id, uerr.message);
      }

      // throttle a touch
      await new Promise(r => setTimeout(r, 150));
    }

    return res(200, {
      ok: true,
      dryRun: dry,
      userId: userId || null,
      scanned: totalScanned,
      updated: dry ? 0 : totalUpdated
    });
  } catch (e) {
    console.error("[memory-backfill] fatal:", e);
    return res(500, { error: "unexpected", detail: String(e.message || e) });
  }
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function res(statusCode, obj) {
  return { statusCode, headers: cors(), body: JSON.stringify(obj) };
}
