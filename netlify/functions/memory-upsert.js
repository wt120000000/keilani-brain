// netlify/functions/memory-upsert.js
// CommonJS wrapper with dynamic import of @supabase/supabase-js.
// Works reliably on Netlify Node 20 even if package.json is "type": "commonjs".

const ok = (body) => ({
  statusCode: 200,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  },
  body: JSON.stringify(body),
});

const bad = (status, body) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return ok({ ok: true });

    if (event.httpMethod !== "POST") {
      return bad(405, { error: "method_not_allowed" });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      return ok({
        error: "server_not_configured",
        detail: "Required env vars missing on Netlify",
        missing: [
          !supabaseUrl ? "SUPABASE_URL" : null,
          !supabaseKey ? "SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE" : null,
        ].filter(Boolean),
      });
    }

    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return ok({ error: "bad_json" });
    }

    const userId = payload.user_id || payload.userId;
    const summary = payload.summary || payload.text;
    const importance =
      typeof payload.importance === "number" ? payload.importance : 0;
    const tags = Array.isArray(payload.tags) ? payload.tags : [];

    if (!userId || !summary) {
      return ok({
        error: "missing_fields",
        need: ["userId", "text"],
        got: Object.keys(payload || {}),
      });
    }

    // Dynamic import inside async handler (works in CJS)
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Table: public.memories (id uuid pk, user_id uuid, summary text, tags text[], importance int, created_at timestamptz)
    const { data, error } = await supabase
      .from("memories")
      .insert({
        user_id: userId,
        summary,
        tags,
        importance,
      })
      .select("id, created_at")
      .single();

    if (error) {
      return ok({ error: "db_insert_failed", detail: error.message });
    }

    return ok({ ok: true, id: data.id, created_at: data.created_at });
  } catch (e) {
    return ok({ error: "server_error", detail: String(e && e.message || e) });
  }
};
