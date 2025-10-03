export async function handler() {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      ok: true,
      node: process.version,
      env: {
        hasUrl: !!process.env.SUPABASE_URL,
        hasServiceKey: !!(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE),
      },
      now: new Date().toISOString(),
    }),
  };
}
export default handler;
