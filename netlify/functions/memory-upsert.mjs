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
  const role   = (payload.role || "user").trim();
  const text   = (payload.text || "").toString();
  const sessionId = (payload.sessionId || "").trim() || null;

  if (!userId || !text) {
    return json(400, {
      error: "missing_fields",
      need: ["userId", "text"],
      got: Object.keys(payload)
    });
  }

  const safeText = text.slice(0, 8000);
  const safeRole = role === "assistant" ? "assistant" : "user";

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false }
  });

  const { data, error } = await supabase
    .from("memories")
    .insert({
      user_id: userId,
      session_id: sessionId,
      role: safeRole,
      text: safeText // matches column "text"
    })
    .select("id, created_at")
    .single();

  if (error) {
    return json(500, { error: "db_insert_failed", detail: error.message });
  }

  return json(200, { ok: true, id: data.id, created_at: data.created_at });
}
