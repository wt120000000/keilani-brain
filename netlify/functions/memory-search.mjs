// netlify/functions/memory-search.mjs
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
  const query = body.query || body.q || null;
  const limit = Number(body.limit || 5);
  const threshold = Number(body.threshold ?? 0.30); // cosine distance

  if (!userId) {
    return resJson(200, {
      error: 'missing_fields',
      need: ['userId'],
      got: Object.keys(body),
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  try {
    // 1) if we have a query, try vector search via RPC
    if (query) {
      const qVec = await embedText(query);

      const { data: vecMatches, error: vecErr } = await supabase.rpc(
        'match_memories',
        {
          in_user_id: userId,
          query_embedding: qVec,
          match_count: limit,
          match_threshold: threshold,
        }
      );

      if (vecErr) {
        console.warn('[mem-search] rpc match_memories failed:', vecErr.message);
      }

      if (Array.isArray(vecMatches) && vecMatches.length > 0) {
        return resJson(200, {
          ok: true,
          mode: 'vector',
          count: vecMatches.length,
          results: vecMatches.map((m) => ({
            id: m.id,
            summary: m.summary,
            tags: m.tags,
            importance: m.importance,
            created_at: m.created_at,
            distance: m.distance,
          })),
        });
      }

      // 2) fallback to trigram-ish filter (ILIKE) if no vector hits
      const { data: txtData, error: txtErr } = await supabase
        .from('memories')
        .select('id, summary, tags, importance, created_at')
        .eq('user_id', userId)
        .ilike('summary', `%${query}%`)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!txtErr && txtData?.length) {
        return resJson(200, {
          ok: true,
          mode: 'text',
          count: txtData.length,
          results: txtData,
        });
      }
    }

    // 3) final fallback: most recent
    const { data: recent, error: recErr } = await supabase
      .from('memories')
      .select('id, summary, tags, importance, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (recErr) {
      return resJson(500, { error: 'db_recent_failed', detail: recErr.message });
    }

    return resJson(200, {
      ok: true,
      mode: 'recent',
      count: recent.length,
      results: recent,
    });
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
