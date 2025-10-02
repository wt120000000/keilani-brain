import { createClient } from '@supabase/supabase-js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...cors },
  body: JSON.stringify(body),
});

// lazy, safe init
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;

  const url =
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_URL_PUBLIC ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SECRET ||
    process.env.SUPABASE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    const missing = [];
    if (!url) missing.push('SUPABASE_URL');
    if (!key) missing.push('SUPABASE_SERVICE_KEY');
    throw new Error('missing_env:' + missing.join(','));
  }
  _supabase = createClient(url, key);
  return _supabase;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  try {
    // env sanity
    const supabase = getSupabase();

    const body = JSON.parse(event.body || '{}');
    const userId = body.userId ?? body.user_id ?? null;
    const summary = body.summary ?? body.text ?? null;

    let tags = body.tags;
    if (typeof tags === 'string') {
      tags = tags.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(tags)) tags = [];

    const importance = Number.isFinite(body.importance) ? Number(body.importance) : 0;

    if (!userId || !summary) {
      return json(400, {
        error: 'missing_fields',
        need: ['userId|user_id', 'summary|text'],
        got: Object.keys(body),
      });
    }

    const { data, error } = await supabase
      .from('memories')
      .insert([{ user_id: userId, summary, tags, importance }])
      .select();

    if (error) throw error;
    return json(200, { ok: true, inserted: data?.[0] ?? null });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.startsWith('missing_env:')) {
      return json(500, {
        error: 'server_not_configured',
        detail: 'Required env vars missing on Netlify',
        missing: msg.replace('missing_env:', '').split(',').filter(Boolean),
      });
    }
    return json(400, { error: msg });
  }
}
