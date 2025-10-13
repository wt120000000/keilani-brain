export default async (request, context) => {
  let payload = {};
  try { payload = await request.json(); } catch {}
  const { message, userId } = payload;

  if (!message || !userId) {
    return new Response(JSON.stringify({ error: "missing_fields", detail: "Provide { message, userId }" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive"
  });

  const body = new ReadableStream({
    start(controller) {
      // telemetry chunk (optional)
      controller.enqueue(`data: ${JSON.stringify({ type: "telemetry", ts: new Date().toISOString() })}\n\n`);
      // a visible delta chunk so the widget prints something immediately
      controller.enqueue(`data: ${JSON.stringify({ type: "delta", content: "Hello from the Edge 👋\\n" })}\n\n`);
      // end
      controller.enqueue(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      controller.close();
    }
  });

  return new Response(body, { headers, status: 200 });
};
