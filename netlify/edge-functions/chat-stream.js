// /netlify/edge-functions/chat-stream.js
// Keilani Edge SSE with AuthZ + Rate Limit + OpenAI proxy
// Runtime: Netlify Edge (Deno). Requires env:
//  - OPENAI_API_KEY
//  - SUPABASE_URL
//  - SUPABASE_ANON_KEY  (or SUPABASE_SERVICE_KEY if you prefer)
// Notes:
//  - Entitlements in table keilani_entitlements (SQL already applied).
//  - Rate limiting via RPC bump_rate_bucket (SQL already applied).

export default async function handler(request) {
  try {
    // Basic method guard
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- AuthN (require Supabase JWT) ---
    const auth = request.headers.get("authorization");
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_KEY");
    if (!SUPABASE_URL || !SUPABASE_ANON) {
      return new Response("Server Misconfigured (Supabase env)", { status: 500 });
    }

    // Verify token with Supabase Auth
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: SUPABASE_ANON },
    });
    if (!userRes.ok) return new Response("Unauthorized", { status: 401 });
    const user = await userRes.json(); // { id, email, ... }

    // --- Entitlements ---
    const entRes = await fetch(
      `${SUPABASE_URL}/rest/v1/keilani_entitlements?select=tier,enabled,rpm,tpm&user_id=eq.${user.id}`,
      { headers: { Authorization: `Bearer ${SUPABASE_ANON}`, apikey: SUPABASE_ANON } }
    );
    if (!entRes.ok) return new Response("Forbidden", { status: 403 });
    const ent = (await entRes.json())?.[0];
    if (!ent?.enabled) return new Response("Forbidden", { status: 403 });

    // --- Rate limit (per minute) ---
    const rlRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_rate_bucket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_ANON}`,
        apikey: SUPABASE_ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user: user.id }),
    });
    if (!rlRes.ok) return new Response("Rate Limit Check Failed", { status: 429 });
    const rl = await rlRes.json(); // [{ allowed, remaining }]
    if (!rl?.[0]?.allowed) {
      return new Response("Rate limit exceeded. Try again soon.", { status: 429 });
    }

    // --- Read request body ---
    const { message, userId, agent, model } = await request.json().catch(() => ({}));
    if (!message) return new Response("Bad Request (message required)", { status: 400 });

    // --- OpenAI upstream stream (Responses API) ---
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) return new Response("Server Misconfigured (OPENAI_API_KEY)", { status: 500 });

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini-2024-07-18",
        input: [
          // lightweight system primer; expand later if needed
          { role: "system", content: "You are Keilani. Be warm, concise, and helpful." },
          { role: "user", content: message }
        ],
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const t = await safeText(upstream);
      return new Response(`Upstream error: ${upstream.status} ${t}`, { status: 502 });
    }

    // --- Create SSE stream to client ---
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Helpers
    const writeEvent = async (event, data) => {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      const s =
        (event ? `event: ${event}\n` : "") +
        `data: ${payload}\n\n`;
      await writer.write(encoder.encode(s));
    };

    // Initial telemetry
    await writeEvent("telemetry", {
      type: "telemetry",
      model: model || "gpt-4o-mini-2024-07-18",
      agent: agent || "keilani",
      ts: new Date().toISOString(),
    });

    // Heartbeat timer
    const heartbeat = setInterval(() => {
      writeEvent("heartbeat", { type: "heartbeat", ts: Date.now() }).catch(() => {});
    }, 10000);

    // Pipe upstream → downstream (normalize to our schema)
    const upstreamReader = upstream.body.getReader();
    const textDecoder = new TextDecoder();

    (async () => {
      try {
        let buffer = "";
        while (true) {
          const { value, done } = await upstreamReader.read();
          if (done) break;
          buffer += textDecoder.decode(value, { stream: true });

          // split SSE frames from OpenAI
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const lines = frame.split("\n");
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;

              try {
                const obj = JSON.parse(data);
                // Responses API emits many types; we forward deltas only as {type:'delta', content:'...'}
                const delta = obj?.delta?.content ?? obj?.output_text ?? obj?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length) {
                  await writeEvent("delta", { type: "delta", content: delta });
                }
              } catch {
                // ignore non-JSON lines quietly
              }
            }
          }
        }
        clearInterval(heartbeat);
        await writeEvent("done", { type: "done" });
      } catch (_e) {
        clearInterval(heartbeat);
        // Best-effort close
        try { await writeEvent("done", { type: "done" }); } catch {}
      } finally {
        try { await writer.close(); } catch {}
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return new Response(`Edge error: ${err?.message || String(err)}`, { status: 500 });
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}
