const { createClient } = require("@supabase/supabase-js");
export const handler = async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth:{persistSession:false} });
  try {
    const { error } = await sb.rpc("purge_old_messages"); // or run raw delete: delete from messages where created_at < now() - interval '90 days';
    if (error) throw error;
    return { statusCode: 200, body: "ok" };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }
};
