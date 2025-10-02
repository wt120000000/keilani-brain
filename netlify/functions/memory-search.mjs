import { createClient } from '@supabase/supabase-js';

/* ---------- config ---------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (statusCode, bodyObj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...cors },
  body: JSON.stringify(bodyObj),
});

/* ---------- handler ---------- */
export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // accept both snake_case and camelCase
    const userId = body.userId ?? body.user_id ?? null;
    const q = body.query ?? body.q ?? '';

    const limit = Number.isFinite(body.limit) ? Math.max(1, Math.min(50, body.limit)) : 5;

    if (!userId) {
      return json(400, { error: 'missing_fields', need: ['userId|user_id'], got: Object.keys(body) });
    }

    // Basic text search using ILIKE (works without pg_trgm)
    let query = supabase
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (q && typeof q === 'string') {
      query = query.ilike('summary', `%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    return json(200, { ok: true, results: data || [] });
  } catch (err) {
    return json(400, { error: String(err?.message || err) });
  }
}
