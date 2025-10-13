// netlify/edge-functions/chat-stream.ts
export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive"
  });

  // Use a ReadableStream and enqueue *immediately*
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // 1) prove first chunk arrives immediately
      send({ type: "telemetry", msg: "hello from edge", t: Date.now() });

      // 2) drip a few deltas
      const parts = ["Kei", "la", "ni", " says hi!"];
      parts.forEach((p, i) => {
        setTimeout(() => send({ type: "delta", content: p }), 200 * (i + 1));
      });

      // 3) finish
      setTimeout(() => {
        send({ type: "done" });
        controller.close();
      }, 1200);
    }
  });

  return new Response(stream, { status: 200, headers });
};
