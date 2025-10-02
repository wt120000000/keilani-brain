// netlify/functions/memory-search.mjs
// Search a user's memories by substring match on "summary" (case-insensitive).
// Body JSON: { user_id: uuid, query: string, limit?: number }

import { createClient } from "@supabase/supabase-js";

/* ---------- helpers ---------- */
const ALLOW_ORIGIN = "*";
const commonHeaders = {
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8",
};

function ok(body) {
  return { statusCode: 200, headers: commonHeaders, body: JSON.stringify(body) };
}
function bad(body) {
  return { statusCode: 200, headers: commonHeaders, body: JSON.stringify(body) };
}

function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    throw {
      code: "server_not_configured",
      message: "Required env vars missing on Netlify",
      missing: [
        ...(supabaseUrl ? [] : ["SUPABASE_URL"]),
        ...(supabaseKey ? [] : ["SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE"]),
      ],
    };
  }
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });
}

/* ---------- function ---------- */
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });

  if (event.httpMethod !== "POST") {
    return bad({ error: "method_not_allowed", detail: "Use POST" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return bad({ error: "invalid_json" });
  }

  const userId = payload.user_id || payload.userId;
  const query = payload.query || payload.q || "";
  const limit = Number.isFinite(payload.limit) ? Math.max(1, payload.limit) : 10;

  if (!userId) {
    return bad({
      error: "missing_fields",
      need: ["userId"],
      got: Object.keys(payload || {}),
    });
  }

  try {
    const supabase = getSupabase();

    // Basic ilike search; if you add pg_trgm + GIN index, this will still work well.
    const { data, error } = await supabase
      .from("memories")
      .select("id, summary, tags, importance, created_at")
      .eq("user_id", userId)
      .ilike("summary", `%${query}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return bad({ error: "db_error", detail: error.message });
    }

    return ok({ ok: true, count: data?.length || 0, results: data || [] });
  } catch (e) {
    if (e?.code === "server_not_configured") {
      return bad({ error: e.code, detail: e.message, missing: e.missing });
    }
    return bad({ error: "server_error", detail: String(e?.message || e) });
  }
}
