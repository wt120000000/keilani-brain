// netlify/functions/memory-upsert.mjs
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE;

function resJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return resJson(200, { ok: true });
  }

  if (!supabaseUrl || !supabaseKey) {
    return resJson(500, {
      error: 'server_not_configured',
      detail: 'Required env vars missing on Netlify',
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE'].filter(
        (k) => !process.env[k]
      ),
    });
  }

  if (event.httpMethod !== 'POST') {
    return resJson(405, { error: 'method_not_allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return resJson(400, { error: 'bad_json' });
  }

  const userId = body.user_id || body.userId;
  const summary = body.summary || body.text;
  const importance = body.importance ?? null;
  const tags = Array.isArray(body.tags) ? body.tags : [];

  if (!userId || !summary) {
    return resJson(200, {
      error: 'missing_fields',
      need: ['userId', 'text'],
      got: Object.keys(body),
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  try {
    // 1) insert the row first (fast write)
    const { data, error } = await supabase
      .from('memories')
      .insert([{ user_id: userId, summary, importance, tags }])
      .select('id, created_at')
      .single();

    if (error) {
      return resJson(500, { error: 'db_insert_failed', detail: error.message });
    }

    const insertedId = data.id;

    // 2) compute embedding (server-side) and update
    try {
      const embedding =
        Array.isArray(body.embedding) && body.embedding.length
          ? body.embedding
          : await embedText(summary);

      if (Array.isArray(embedding) && embedding.length > 0) {
        const { error: upErr } = await supabase
          .from('memories')
          .update({ embedding })
          .eq('id', insertedId);

        if (upErr) {
          // not fatal – row exists without embedding; a background job could fill it later
          console.warn('[mem-upsert] embedding update failed:', upErr.message);
        }
      }
    } catch (e) {
      console.warn('[mem-upsert] embedText failed:', e?.message || e);
      // non-fatal
    }

    return resJson(200, { ok: true, id: insertedId, created_at: data.created_at });
  } catch (e) {
    return resJson(500, { error: 'server_error', detail: String(e) });
  }
};

// ---- helpers ----

async function embedText(input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const payload = {
    model: 'text-embedding-3-small',
    input,
  };
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI embeddings failed: ${r.status} ${t}`);
  }
  const j = await r.json();
  const vec = j?.data?.[0]?.embedding || [];
  return vec;
}

export default { handler };
