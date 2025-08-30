
// netlify/functions/forget.mjs
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default async function handler(request) {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: JSON_HEADERS });
    }

    const body = await request.json().catch(() => ({}));
    const userId = body.userId || null;
    const title  = body.title  || null;
    const source = body.source || null;

    if (userId) {
      // Wipe user data
      const ops = [
        sb.from("messages").delete().eq("user_id", userId),
        sb.from("subscriptions").delete().eq("user_id", userId),
        sb.from("entitlements").delete().eq("user_id", userId),
        sb.from("user_plans").delete().eq("user_id", userId),
        sb.from("app_users").delete().eq("id", userId)
      ];
      const results = await Promise.allSettled(ops);
      const failed  = results.filter(r => r.status === "rejected");
      if (failed.length) throw new Error("partial_delete_failed");
      return new Response(JSON.stringify({ ok: true, userDeleted: userId }), { status: 200, headers: JSON_HEADERS });
    }

    // Otherwise, KB chunk deletion by title/source (your original behavior)
    if (!title && !source) {
      return new Response(JSON.stringify({ error: "provide userId OR title/source" }), { status: 400, headers: JSON_HEADERS });
    }
    let q = sb.from("kb_chunks").delete();
    if (title)  q = q.eq("title", title);
    if (source) q = q.eq("source", source);
    const { count, error } = await q.select("id", { count: "exact" });
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true, kbDeleted: count ?? 0 }), { status: 200, headers: JSON_HEADERS });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: JSON_HEADERS });
  }
}
