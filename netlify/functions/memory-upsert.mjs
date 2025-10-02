// netlify/functions/memory-upsert.mjs
// Upsert a single "memory" row for a user.
// Body JSON: { user_id: uuid, summary: string, importance?: number, tags?: string[] }

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
  const summary = payload.summary || payload.text; // allow legacy "text"
  const importance = Number.isFinite(payload.importance)
    ? payload.importance
    : null;
  const tags = Array.isArray(payload.tags) ? payload.tags : null;

  if (!userId || !summary) {
    return bad({
      error: "missing_fields",
      need: ["userId", "summary"],
      got: Object.keys(payload || {}),
    });
  }

  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("memories")
      .insert([{ user_id: userId, summary, importance, tags }])
      .select("id, created_at")
      .single();

    if (error) {
      return bad({ error: "db_error", detail: error.message });
    }

    return ok({ ok: true, id: data.id, created_at: data.created_at });
  } catch (e) {
    if (e?.code === "server_not_configured") {
      return bad({ error: e.code, detail: e.message, missing: e.missing });
    }
    return bad({ error: "server_error", detail: String(e?.message || e) });
  }
}
