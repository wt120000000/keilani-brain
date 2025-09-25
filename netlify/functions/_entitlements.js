// netlify/functions/_entitlements.js
const { createClient } = require("@supabase/supabase-js");

const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

// Ensure a user exists
async function ensureUser(userId) {
  await supa.from("app_users").upsert({ id: userId }).select().single();
}

exports.getEntitlements = async (userId) => {
  await ensureUser(userId);

  // entitlements (plan, limits)
  const { data: entRow } = await supa.from("entitlements")
    .select("plan,max_messages_per_day").eq("user_id", userId).single();

  const ent = {
    plan: entRow?.plan || "free",
    max_messages_per_day: entRow?.max_messages_per_day ?? 30
  };

  // usage last 24 hours
  const { data: usageRow } = await supa.from("v_daily_usage")
    .select("messages_used_24h").eq("user_id", userId).single();

  const usage = { messages_used: usageRow?.messages_used_24h ?? 0 };
  return { ent, usage };
};

// optional: persist messages (call from chat.js if you want full history)
exports.saveMessages = async (userId, convo = []) => {
  if (!Array.isArray(convo) || !convo.length) return;
  const rows = convo.slice(-10).map(m => ({ user_id: userId, role: m.role, content: m.content }));
  await supa.from("messages").insert(rows);
};
