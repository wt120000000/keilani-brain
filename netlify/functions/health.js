exports.handler = async () => {
  const has = (k) => !!process.env[k];
  const res = {
    has_OPENAI_API_KEY: has("OPENAI_API_KEY"),
    has_OPENAI_MODEL: true,
    has_EMBED_MODEL: true,
    has_SUPABASE_URL: !!process.env.SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!process.env.SUPABASE_SERVICE_ROLE
  };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(res)
  };
};
