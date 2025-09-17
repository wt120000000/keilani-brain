// Edge chat streaming via OpenAI, fixed for Netlify Edge env access
// Uses Netlify.env.get instead of Deno.env.get

export default async (request, context) => {
  try {
    // IMPORTANT: use Netlify.env.get in Edge runtime
    const OPENAI_API_KEY = Netlify.env.get('OPENAI_API_KEY');
    if (!OPENAI_API_KEY) {
      return json({ error: 'missing_openai_key' }, 500);
    }

    const { message, history = [], voice = '', sessionId = '' } = await safeJson(request);

    if (!message || typeof message !== 'string') {
      return json({ error: 'missing_text' }, 400);
    }

    // Build a compact messages array from history + new user message
    const msgs = [];
    for (const h of history) {
      if (h && h.role && h.content) {
        msgs.push({ role: h.role, content: String(h.content).slice(0, 4000) });
      }
    }
    msgs.push({ role: 'user', content: message.slice(0, 4000) });

    // Create a streaming response from OpenAI Chat Completions
    const oaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        stream: true,
        messages: msgs
      })
    });

    if (!oaiResp.ok || !oaiResp.body) {
      const raw = await oaiResp.text();
      return json({ error: 'openai_error', detail: raw }, 502);
    }

    // Stream out as SSE
    const stream = oaiResp.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream({
        transform(chunk, controller) {
          // Pass through OpenAI SSE as-is; also allow simple text chunks
          // If the upstream is JSON lines, the UI already parses lines prefixed "data:"
          controller.enqueue(chunk);
        }
      }))
      .pipeThrough(new TextEncoderStream());

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': 'https://api.keilani.ai'
      }
    });

  } catch (err) {
    return json({ error: 'chat_stream_exception', detail: String(err?.message || err) }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://api.keilani.ai'
    }
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
