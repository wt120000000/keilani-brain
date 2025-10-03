// netlify/functions/memory-search.js

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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return ok({ ok: true });
    if (event.httpMethod !== "POST") return ok({ error: "method_not_allowed" });

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
    const query = (payload.query || "").toString().trim();
    const limit = Math.min(Math.max(parseInt(payload.limit || 5, 10), 1), 25);

    if (!userId) {
      return ok({ error: "missing_fields", need: ["userId"], got: Object.keys(payload || {}) });
    }

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(supabaseUrl, supabaseKey);

    let results = [];
    let mode = "recent";

    if (query) {
      const { data, error } = await supabase
        .from("memories")
        .select("id, summary, tags, importance, created_at")
        .eq("user_id", userId)
        .ilike("summary", `%${query}%`)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        return ok({ error: "db_search_failed", detail: error.message });
      }

      results = data || [];
      mode = "text";
    }

    if (!results.length) {
      const { data, error } = await supabase
        .from("memories")
        .select("id, summary, tags, importance, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        return ok({ error: "db_recent_failed", detail: error.message });
      }

      results = data || [];
      mode = "recent_fallback";
    }

    return ok({ ok: true, mode, count: results.length, results });
  } catch (e) {
    return ok({ error: "server_error", detail: String(e && e.message || e) });
  }
};
