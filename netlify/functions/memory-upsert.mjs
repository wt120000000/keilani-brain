import { createClient } from '@supabase/supabase-js';

/** small helper to return a well-formed Netlify response */
const json = (status, payload = {}) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  },
  body: JSON.stringify(payload),
});

export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return json(200, {});

  try {
    const supabaseUrl =
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      const missing = [];
      if (!supabaseUrl) missing.push('SUPABASE_URL');
      if (!supabaseKey) missing.push('SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE');
      return json(500, {
        error: 'server_not_configured',
        detail: 'Required env vars missing on Netlify',
        missing,
      });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    // accept either user_id or userId, summary or text
    const userId = body.user_id || body.userId;
    const text = body.summary || body.text;
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const importance =
      Number.isFinite(body.importance) ? body.importance : 1;

    if (!userId || !text) {
      return json(200, {
        error: 'missing_fields',
        need: ['userId', 'text'],
        got: Object.keys(body),
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // simple insert (let DB generate id/created_at)
    const { data, error } = await supabase
      .from('memories')
      .insert([{ user_id: userId, summary: text, tags, importance }])
      .select('id, created_at')
      .single();

    if (error) return json(500, { error: 'db_error', detail: error.message });

    return json(200, { ok: true, id: data.id, created_at: data.created_at });
  } catch (err) {
    return json(500, { error: 'exception', detail: String(err) });
  }
}

export default handler;
