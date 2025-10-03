// netlify/functions/memory-search.mjs
// Search user memories by query, or return recent memories when { recent: true }.
// Fields returned: id, summary, tags, importance, created_at

import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return res(405, { error: "method_not_allowed" });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE; // <- you configured SERVICE_ROLE

    if (!supabaseUrl || !supabaseKey) {
      return res(500, {
        error: "server_not_configured",
        detail: "Required env vars missing on Netlify",
        missing: [
          ...(supabaseUrl ? [] : ["SUPABASE_URL"]),
          ...(supabaseKey ? [] : ["SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE"]),
        ],
      });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const userId = (body.userId || body.user_id || "").trim();
    const query = (body.query || "").trim();
    const limit = Number(body.limit) || 8;
    const wantRecent = !!body.recent;
    const limitRecent = Number(body.limitRecent) || 5;

    if (!userId) {
      return res(200, { error: "missing_fields", need: ["userId"] });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

    // Recent fallback path
    if (wantRecent || !query) {
      const { data, error } = await supabase
        .from("memories")
        .select("id, summary, tags, importance, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limitRecent);

      if (error) {
        return res(500, { error: "db_error", detail: error.message });
      }

      return res(200, {
        ok: true,
        mode: "recent_fallback",
        count: data?.length || 0,
        results: data || [],
      });
    }

    // Query path (simple text/trigram search on summary; tags partial match)
    // NOTE: Keep simple/fast: ilike on summary; optionally filter by tags via contains when a single-word token exists
    const q = query.length > 120 ? query.slice(0, 120) : query;

    let base = supabase
      .from("memories")
      .select("id, summary, tags, importance, created_at")
      .eq("user_id", userId)
      .ilike("summary", `%${q}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    const { data, error } = await base;
    if (error) {
      return res(500, { error: "db_error", detail: error.message });
    }

    return res(200, {
      ok: true,
      mode: "text",
      count: data?.length || 0,
      results: data || [],
    });
  } catch (err) {
    return res(500, { error: "server_error", detail: String(err?.message || err) });
  }
}

function res(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
    body: JSON.stringify(obj),
  };
}
