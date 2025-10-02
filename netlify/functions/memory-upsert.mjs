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
    const summary = body.summary ?? body.text ?? null;

    // tags may be array or comma-separated string
    let tags = body.tags;
    if (typeof tags === 'string') {
      tags = tags.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(tags)) tags = [];

    const importance = Number.isFinite(body.importance)
      ? Number(body.importance)
      : 0;

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

    return json(200, { ok: true, inserted: data?.[0] || null });
  } catch (err) {
    return json(400, { error: String(err?.message || err) });
  }
}
