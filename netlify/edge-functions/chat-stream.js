// netlify/edge-functions/chat-stream.js
// Edge streaming + lightweight memory (remember/recall) via Supabase REST

export default async (request, context) => {
  const { searchParams } = new URL(request.url);
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  try {
    const { message, voice, sessionId, userId } = await request.json();

    if (!message || !userId) {
      return json({ error: 'missing_params', detail: 'message and userId required' }, 400);
    }

    // Handle memory commands early
    const low = message.trim().toLowerCase();
    if (low.startsWith('remember ') || low.startsWith('save ')) {
      const content = message.replace(/^(\s*remember|\s*save)\s*/i, '').trim();
      if (!content) return streamSimple("I didn't catch what to remember.");
      const ok = await saveMemory(userId, sessionId, content);
      return streamSimple(ok ? 'Saved to memory.' : 'I could not save that to memory.');
    }
    if (
      /^(recall|what do you remember|show memories|list memories)\b/i.test(low)
    ) {
      const items = await loadMemories(userId, 10);
      if (!items.length) return streamSimple('I have no memories yet.');
      const text = items.map(i => `• ${i.content}`).join('\n');
      return streamSimple(text);
    }

    // Normal chat: load memories to prime the model
    const memories = await loadMemories(userId, 8);
    const memoryBlock = memories.length
      ? `Relevant notes for this user:\n${memories.map(m => `- ${m.content}`).join('\n')}`
      : '';

    // Stream OpenAI chat completion
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env('OPENAI_API_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        stream: true,
        messages: [
          {
            role: 'system',
            content:
              `You are Keilani. Be helpful and friendly.\n` +
              (memoryBlock ? `${memoryBlock}\n` : '') +
              `If the user asks you to remember/recall we already handled it server-side.`
          },
          { role: 'user', content: message }
        ]
      })
    });

    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '');
      return json({ error: 'openai_error', detail: raw || res.statusText }, 500);
    }

    const transform = new TransformStream();
    const writer = transform.writable.getWriter();
    const reader = res.body.getReader();
    const enc = (s) => writer.write(new TextEncoder().encode(s));

    // relay OpenAI SSE as `data: {delta}` lines
    (async () => {
      try {
        enc(''); // flush headers
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = new TextDecoder().decode(value);
          for (const line of chunk.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              const d = j.choices?.[0]?.delta?.content || '';
              if (d) await enc(`data: ${JSON.stringify({ delta: d })}\n\n`);
            } catch {
              // pass raw
              await enc(`data: ${JSON.stringify({ delta: data })}\n\n`);
            }
          }
        }
      } catch (e) {
        await enc(`data: ${JSON.stringify({ delta: '\n[stream ended]' })}\n\n`);
      } finally {
        await writer.close();
      }
    })();

    return new Response(transform.readable, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (err) {
    return json({ error: 'chat_stream_exception', detail: String(err?.message || err) }, 500);
  }
};

export const config = { path: '/api/chat-stream' };

/* ---------- Helpers ---------- */
function env(k) {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env: ${k}`);
  return v;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}

async function streamSimple(text) {
  const ts = new TransformStream();
  const w = ts.writable.getWriter();
  const enc = new TextEncoder();
  // break into small chunks for a nice streamy feel
  for (const piece of chunker(text, 60)) {
    await w.write(enc.encode(`data: ${JSON.stringify({ delta: piece })}\n\n`));
  }
  await w.close();
  return new Response(ts.readable, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    }
  });
}

function* chunker(str, n) {
  let i = 0;
  while (i < str.length) {
    yield str.slice(i, i + n);
    i += n;
  }
}

/* ---------- Supabase minimal REST helpers ---------- */
async function saveMemory(userId, sessionId, content) {
  const url = `${env('SUPABASE_URL')}/rest/v1/memory`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': env('SUPABASE_SERVICE_ROLE'),
      'Authorization': `Bearer ${env('SUPABASE_SERVICE_ROLE')}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify([{ user_id: userId, session_id: sessionId || null, type: 'note', content }])
  });
  return r.ok;
}

async function loadMemories(userId, limit = 8) {
  const url = `${env('SUPABASE_URL')}/rest/v1/memory?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=${limit}`;
  const r = await fetch(url, {
    headers: {
      'apikey': env('SUPABASE_SERVICE_ROLE'),
      'Authorization': `Bearer ${env('SUPABASE_SERVICE_ROLE')}`,
      'Accept': 'application/json'
    }
  });
  if (!r.ok) return [];
  return await r.json();
}
