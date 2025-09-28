// Edge chat streaming via OpenAI (SSE pass-through + keepalive)
export default async (request) => {
  const ORIGIN = 'https://api.keilani.ai'; // set to * for localhost if needed
  try {
    const OPENAI_API_KEY = Netlify.env.get('OPENAI_API_KEY');
    if (!OPENAI_API_KEY) return j({ error: 'missing_openai_key' }, 500, ORIGIN);

    const body = await safeJson(request);
    const message = typeof body?.message === 'string' ? body.message : '';
    const history = Array.isArray(body?.history) ? body.history : [];
    if (!message) return j({ error: 'missing_text' }, 400, ORIGIN);

    const msgs = [];
    for (const h of history) if (h?.role && h?.content)
      msgs.push({ role: h.role, content: String(h.content).slice(0, 4000) });
    msgs.push({ role: 'user', content: message.slice(0, 4000) });

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages: msgs })
    });

    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text().catch(()=> '');
      return j({ error: 'openai_error', detail: raw }, 502, ORIGIN);
    }

    // Keep-alive every 15s so proxies don’t cut idle streams
    const encoder = new TextEncoder();
    const keep = new ReadableStream({
      start(ctrl) { this.t = setInterval(() => ctrl.enqueue(encoder.encode(`: keepalive\n\n`)), 15000); },
      cancel() { clearInterval(this.t); }
    });

    const merged = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`: hello\n\n`));
        const reader = upstream.body.getReader();
        const keepReader = keep.getReader();
        (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch (e) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(String(e?.message||e))}\n\n`));
          } finally {
            controller.close();
            keepReader.cancel().catch(()=>{});
          }
        })();
      }
    });

    return new Response(merged, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': ORIGIN,
        'Vary': 'Origin'
      }
    });
  } catch (err) {
    return j({ error: 'chat_stream_exception', detail: String(err?.message || err) }, 500, ORIGIN);
  }
};

function j(obj, status = 200, origin='*') {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
  });
}
async function safeJson(req){ try { return await req.json(); } catch { return {}; } }
