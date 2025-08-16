import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
const JSON_HEADERS = { "Content-Type": "application/json" };

// WARNING: server-side only. Never expose Service Role to client.
export default async function handler(request) {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: JSON_HEADERS });
    }
    const { title, source } = await request.json().catch(() => ({}));
    if (!title && !source) {
      return new Response(JSON.stringify({ error: "provide title or source" }), { status: 400, headers: JSON_HEADERS });
    }
    let q = supabase.from("kb_chunks").delete();
    if (title) q = q.eq("title", title);
    if (source) q = q.eq("source", source);
    const { count, error } = await q.select("id", { count: "exact" });
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true, deleted: count ?? 0 }), { status: 200, headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: JSON_HEADERS });
  }
}
