// netlify/functions/log-turn.js
import { createClient } from '@supabase/supabase-js';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { sessionId, user, assistant, meta, ts } = JSON.parse(event.body || '{}');
    if (!sessionId) return { statusCode: 400, body: 'Missing sessionId' };

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE; // service-role (server only)
    if (!supabaseUrl || !supabaseKey) {
      return { statusCode: 500, body: 'Supabase not configured' };
    }

    const supabase = createClient(supabaseUrl, supabaseKey, { auth:{ persistSession:false } });

    const { error } = await supabase.from('turns').insert({
      session_id: sessionId,
      user_text: user ?? null,
      assistant_text: assistant ?? null,
      meta: meta ?? null,
      ts: ts ?? Date.now()
    });

    if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify({ ok:true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
