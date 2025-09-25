// netlify/functions/stream-chat.js  (CommonJS, ESLint-friendly)
exports.handler = async function (event) {
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  };

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const message = body.message || "Say hi in 1 sentence.";

    // Node 18+ on Netlify has fetch/ReadableStream/Response globally
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: "You are Keilani: concise, flirty-fun, helpful." },
          { role: "user", content: message }
        ]
      })
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return new Response(
        `event: error\ndata: ${JSON.stringify({ status: upstream.status, text })}\n\n`,
        { status: 200, headers }
      );
    }

    // Pipe SSE 1:1
    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value); // already `data:` lines
          }
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, { status: 200, headers });
  } catch (err) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`,
      { status: 200, headers }
    );
  }
};
