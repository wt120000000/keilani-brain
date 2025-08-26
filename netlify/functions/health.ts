import type { Handler } from "@netlify/functions";

export const handler: Handler = async () => {
  const checks = {
    openai: !!process.env.OPENAI_API_KEY,
    supabaseUrl: !!process.env.SUPABASE_URL,
    supabaseKey: !!(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE),

    // D-ID is informational for now (not required for ok)
    didClientKey: !!process.env.DID_CLIENT_KEY,
    didAgentId: !!process.env.DID_AGENT_ID,
    didApiKey: !!process.env.DID_API_KEY,
  };

  const ok = checks.openai && checks.supabaseUrl && checks.supabaseKey;

  return {
    statusCode: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok, checks }),
  };
};
