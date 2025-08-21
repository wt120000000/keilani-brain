// Minimal health check (ESM)
export const handler = async () => {
  const hasSupabaseKey =
    !!(process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY);

  const whichKey =
    process.env.SUPABASE_SERVICE_ROLE
      ? "SUPABASE_SERVICE_ROLE"
      : (process.env.SUPABASE_KEY ? "SUPABASE_KEY" : null);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({
      ok: true,
      env: {
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_KEY: hasSupabaseKey,       // true if either var is set
        SUPABASE_WHICH: whichKey,           // which one was found
        NODE_VERSION: process.env.NODE_VERSION || null,
      },
    }),
  };
};
