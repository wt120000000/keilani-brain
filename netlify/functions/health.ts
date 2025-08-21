import type { Handler } from "@netlify/functions";
export const handler: Handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      ok: true,
      env: {
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_KEY: !!process.env.SUPABASE_KEY,
      }
    })
  };
};
