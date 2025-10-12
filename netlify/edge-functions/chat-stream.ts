export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const message = (body?.message ?? "").trim();
  const agent = (body?.agent ?? "keilani").trim();
  const userId = (body?.userId ?? "anon").toString();

  if (!message) return json({ error: "missing_message" }, 400);

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const enc = new TextEncoder();
  const sse = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const stream = new ReadableStream({
    async start(c) {
      c.enqueue(sse({ type: "telemetry", userId, memCount: 0, memMode: "none", ts: Date.now() }));
      const text = `Hey, I'm ${agent}. You said: ${message} `;
      for (const ch of text) { c.enqueue(sse({ type:"delta", content: ch })); await sleep(10); }
      c.enqueue(sse({ type: "done" })); c.close();
    }
  });

  return new Response(stream, { headers, status: 200 });
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
