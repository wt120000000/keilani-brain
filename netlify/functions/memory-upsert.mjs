let createClient;
try {
  ({ createClient } = await import('@supabase/supabase-js'));
} catch (e) {
  console.error('[upsert] failed to import supabase-js', e);
}

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
  try {
    if (event.httpMethod === 'OPTIONS') return json(200, {});

    if (!createClient) {
      return json(500, { error: 'module_import_failed', detail: 'supabase-js not available' });
    }

    const supabaseUrl =
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      const missing = [];
      if (!supabaseUrl) missing.push('SUPABASE_URL');
      if (!supabaseKey) missing.push('SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE');
      console.error('[upsert] missing env', missing);
      return json(500, { error: 'server_not_configured', missing });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const userId = body.user_id || body.userId;
    const text = body.summary || body.text;
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const importance = Number.isFinite(body.importance) ? body.importance : 1;

    if (!userId || !text) {
      return json(200, {
        error: 'missing_fields',
        need: ['userId', 'text'],
        got: Object.keys(body),
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from('memories')
      .insert([{ user_id: userId, summary: text, tags, importance }])
      .select('id, created_at')
      .single();

    if (error) {
      console.error('[upsert] db_error', error);
      return json(500, { error: 'db_error', detail: error.message });
    }

    return json(200, { ok: true, id: data.id, created_at: data.created_at });
  } catch (err) {
    console.error('[upsert] exception', err);
    return json(500, { error: 'exception', detail: String(err) });
  }
}
export default handler;
