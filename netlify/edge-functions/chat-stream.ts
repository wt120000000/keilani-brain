// netlify/edge-functions/chat-stream.ts
export default async function handler(req: Request) {
  // 1) Method gate
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // 2) Parse JSON safely
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const message = (body?.message ?? "").trim();
  const agent = (body?.agent ?? "keilani").trim();

  if (!message) {
    return json({ error: "missing_message" }, 400);
  }

  // 3) (TEMP) simple echo stream so we can verify transport
  //    Swap this block for your OpenAI stream once 200s flow.
  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const encoder = new TextEncoder();
  const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({ type: "telemetry", memCount: 0, memMode: "none", ts: Date.now() }));
      const text = `Hey, I'm ${agent}. You said: ${message} `;
      for (const ch of text) {
        controller.enqueue(sse({ type: "delta", content: ch }));
        await sleep(10);
      }
      controller.enqueue(sse({ type: "done" }));
      controller.close();
    },
  });

  return new Response(stream, { headers, status: 200 });
}

// -------- helpers --------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
