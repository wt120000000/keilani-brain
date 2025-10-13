// netlify/edge-functions/chat-stream.ts
// Deno/Edge-safe JSON-line SSE bridge

export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  // 1) read payload
  let message = "";
  let userId = "anon";
  try {
    const body = await req.json();
    message = (body?.message ?? "").toString();
    userId = (body?.userId ?? "anon").toString();
  } catch {}
  if (!message) {
    return new Response(JSON.stringify({ error: "missing_fields", detail: "Provide { message, userId }" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  // 2) open a SSE response
  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    // allow Netlify/Edge to stream
    "transfer-encoding": "chunked"
  });

  // 3) stream to client
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const write = async (obj: unknown) => {
    const line = `data: ${JSON.stringify(obj)}\n`;
    await writer.write(new TextEncoder().encode(line + "\n"));
  };

  (async () => {
    try {
      // 4) call OpenAI as raw fetch (Edge-friendly)
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${Deno.env.get("OPENAI_API_KEY") || ""}`
        },
        body: JSON.stringify({
          model: Deno.env.get("OPENAI_MODEL_CHAT") || "gpt-4o-mini-2024-07-18",
          stream: true,
          messages: [
            { role: "system", content: "You are Keilani, a friendly AI influencer. Keep replies concise and positive." },
            { role: "user", content: message }
          ],
          // keep output very streamy
          temperature: 0.7
        })
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        await write({ error: "upstream_openai_error", status: res.status, detail: text });
        await write({ type: "done" });
        await writer.close();
        return;
        }

      // 5) parse OpenAI SSE and re-emit compact JSON lines
      const dec = new TextDecoder();
      const reader = res.body.getReader();
      let buf = "";

      // optional telemetry line so the client shows something immediately
      await write({ type: "telemetry", memCount: 0, memMode: "none", timestamp: new Date().toISOString() });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);

          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload);
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (delta) await write({ type: "delta", content: delta });
          } catch {
            // ignore non-JSON lines
          }
        }
      }

      await write({ type: "done" });
      await writer.close();
    } catch (err) {
      await write({ error: "edge_exception", detail: (err as Error)?.message || String(err) });
      await write({ type: "done" });
      await writer.close();
    }
  })();

  return new Response(readable, { status: 200, headers });
};
