export default async function handler() {
  const ok = {
    has_OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    has_OPENAI_MODEL: !!process.env.OPENAI_MODEL,
    has_EMBED_MODEL: !!process.env.EMBED_MODEL,
    has_SUPABASE_URL: !!process.env.SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!process.env.SUPABASE_SERVICE_ROLE,
  };
  return new Response(JSON.stringify(ok), { status: 200, headers: { "Content-Type": "application/json" } });
}
