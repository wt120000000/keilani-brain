const { createClient } = require("@supabase/supabase-js");

function supa(service = false) {
  return createClient(process.env.SUPABASE_URL, service ? process.env.SUPABASE_SERVICE_ROLE : process.env.SUPABASE_ANON_KEY);
}

export const handler = async (event) => {
  try {
    const userId = (event.headers["x-user-id"] || event.headers["X-User-Id"]);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };

    const sb = supa(true);

    const { data: plan } = await sb.from("user_plans").select("*").eq("user_id", userId).maybeSingle();
    const tierCode = plan?.tier_code || "FREE";

    const { data: ents } = await sb.from("tier_entitlements").select("key,value").eq("tier_code", tierCode);
    const entitlements = {};
    (ents || []).forEach(e => (entitlements[e.key] = e.value));

    const today = new Date().toISOString().slice(0,10);
    const { data: usage } = await sb.from("usage_daily").select("messages_used,voice_seconds_used")
      .eq("user_id", userId).eq("date", today).maybeSingle();

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: tierCode, entitlements, usage: usage || { messages_used: 0, voice_seconds_used: 0 } }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
