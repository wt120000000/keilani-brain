// /netlify/functions/health.mjs

export async function handler() {
  const checks = {
    openai: !!process.env.OPENAI_API_KEY,
    supabaseUrl: !!process.env.SUPABASE_URL,
    supabaseKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    didApiKey: !!process.env.DID_API_KEY, // 👈 New check
  };

  const allGood = Object.values(checks).every(Boolean);

  return {
    statusCode: allGood ? 200 : 500,
    body: JSON.stringify({
      ok: allGood,
      checks,
    }),
  };
}

