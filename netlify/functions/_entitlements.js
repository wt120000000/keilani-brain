const { createClient } = require("@supabase/supabase-js");

async function getEntitlements(userId) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
  const { data: plan } = await sb.from("user_plans").select("*").eq("user_id", userId).maybeSingle();
  const tier = plan?.tier_code || "FREE";

  const { data: ents } = await sb.from("tier_entitlements").select("key,value").eq("tier_code", tier);
  const ent = {};
  (ents || []).forEach(e => (ent[e.key] = e.value));

  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await sb.from("usage_daily").select("*").eq("user_id", userId).eq("date", today).maybeSingle();

  return {
    tier,
    ent,
    usage: usage || { user_id: userId, date: today, messages_used: 0, voice_seconds_used: 0 },
  };
}

async function bumpUsage(userId, { messages = 0, voiceSeconds = 0 }) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await sb.from("usage_daily").select("*").eq("user_id", userId).eq("date", today).maybeSingle();
  const row = data || { user_id: userId, date: today, messages_used: 0, voice_seconds_used: 0 };
  row.messages_used += messages;
  row.voice_seconds_used += voiceSeconds;
  await sb.from("usage_daily").upsert(row);
}

module.exports = { getEntitlements, bumpUsage };