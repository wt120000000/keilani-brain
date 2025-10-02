import { createClient } from "@supabase/supabase-js";

const json = (status, body) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  },
  body: JSON.stringify(body)
});

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return json(500, {
      error: "server_misconfig",
      detail: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env var"
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "bad_json", detail: "Request body must be valid JSON" });
  }

  const userId = (payload.userId || "").trim();
  const query  = (payload.query || "").toString();
  const k      = Math.max(1, Math.min(50, Number(payload.k || 5)));

  if (!userId) {
    return json(400, {
      error: "missing_fields",
      need: ["userId"],
      got: Object.keys(payload)
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false }
  });

  let qb = supabase
    .from("memories")
    .select("id, role, text, created_at")
    .eq("user_id", userId);

  if (query) {
    qb = qb.ilike("text", `%${query}%`).order("created_at", { ascending: false }).limit(k);
  } else {
    qb = qb.order("created_at", { ascending: false }).limit(k);
  }

  const { data, error } = await qb;

  if (error) {
    return json(500, { error: "db_query_failed", detail: error.message });
  }

  return json(200, { results: data || [] });
}
