// netlify/edge-functions/chat-stream.js
function sse(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

export default async (request) => {
  // allow both GET (query) and POST (json) for testing
  let payload = {};
  try {
    if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
      payload = await request.json();
    } else {
      const u = new URL(request.url);
      payload = Object.fromEntries(u.searchParams.entries());
    }
  } catch {}

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    // prevents certain proxies from buffering SSE
    "x-accel-buffering": "no",
  });

  const body = new ReadableStream({
    start(controller) {
      const ts = new Date().toISOString();
      controller.enqueue(sse({ type: "telemetry", ts, parsed: payload }));

      // stream a few chunks so we can see it clearly in devtools/curl
      controller.enqueue(sse({ type: "delta", content: "🟢 SSE up\n" }));
      let n = 1;
      const id = setInterval(() => {
        controller.enqueue(sse({ type: "delta", content: `tick ${n++}\n` }));
        if (n > 3) {
          clearInterval(id);
          controller.enqueue(sse({ type: "done" }));
          controller.close();
        }
      }, 500);
    }
  });

  return new Response(body, { headers, status: 200 });
};
