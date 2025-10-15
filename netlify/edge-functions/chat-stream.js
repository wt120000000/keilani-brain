// /netlify/edge-functions/chat-stream.js
// Keilani Edge SSE with Supabase Auth (incl. anonymous), free-tier fallback, rate limit, and OpenAI proxy.
// Env required:
//   OPENAI_API_KEY
//   SUPABASE_URL
//   SUPABASE_ANON_KEY   (or SUPABASE_SERVICE_KEY)
//
// DB prerequisites already applied by you:
//   - keilani_entitlements (optional row per user; free-tier when missing)
//   - rate_buckets + RPC bump_rate_bucket(p_user uuid)    -- defaults to rpm=10 when entitlement missing

export default async function handler(request) {
  try {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const auth = request.headers.get("authorization");
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_KEY =
      Deno.env.get("SUPABASE_SERVICE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return new Response("Server Misconfigured (Supabase env)", { status: 500 });
    }

    // --- Verify Supabase JWT (works for anonymous & regular users)
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: SUPABASE_KEY },
    });
    if (!userRes.ok) return new Response("Unauthorized", { status: 401 });
    const user = await userRes.json(); // { id, email?, ... }

    // --- Entitlements: allow missing row → free tier
    const entRes = await fetch(
      `${SUPABASE_URL}/rest/v1/keilani_entitlements?select=tier,enabled,rpm,tpm&user_id=eq.${user.id}`,
      { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
    );

    let ent = null;
    if (entRes.ok) {
      ent = (await entRes.json())?.[0] || null;
    }
    if (!ent) {
      ent = { tier: "free", enabled: true, rpm: 10, tpm: 2000 };
    }
    if (!ent.enabled) return new Response("Forbidden", { status: 403 });

    // --- Per-user rate limit (uses RPM from DB function default when row missing)
    const rlRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_rate_bucket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user: user.id }),
    });
    if (!rlRes.ok) return new Response("Rate Limit Check Failed", { status: 429 });
    const rl = await rlRes.json(); // [{ allowed, remaining }]
    if (!rl?.[0]?.allowed) {
      return new Response("Rate limit exceeded. Try again soon.", { status: 429 });
    }

    // --- Request payload
    const { message, userId, agent, model } = await request.json().catch(() => ({}));
    if (!message) return new Response("Bad Request (message required)", { status: 400 });

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) return new Response("Server Misconfigured (OPENAI_API_KEY)", { status: 500 });

    // --- Upstream: OpenAI Responses stream
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini-2024-07-18",
        input: [
          { role: "system", content: "You are Keilani. Be warm, concise, and helpful." },
          { role: "user", content: message },
        ],
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const t = await safeText(upstream);
      return new Response(`Upstream error: ${upstream.status} ${t}`, { status: 502 });
    }

    // --- SSE to client
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    const writeEvent = async (event, data) => {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      await writer.write(enc.encode((event ? `event: ${event}\n` : "") + `data: ${payload}\n\n`));
    };

    // Initial telemetry
    await writeEvent("telemetry", {
      type: "telemetry",
      model: model || "gpt-4o-mini-2024-07-18",
      agent: agent || "keilani",
      ts: new Date().toISOString(),
      tier: ent.tier,
    });

    // Heartbeat
    const hb = setInterval(() => {
      writeEvent("heartbeat", { type: "heartbeat", ts: Date.now() }).catch(() => {});
    }, 10_000);

    // Pipe OpenAI → client, normalized to {type:'delta', content:'...'}
    const r = upstream.body.getReader();
    const dec = new TextDecoder();
    (async () => {
      try {
        let buf = "";
        while (true) {
          const { value, done } = await r.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });

          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const obj = JSON.parse(data);
                const delta =
                  obj?.delta?.content ??
                  obj?.output_text ??
                  obj?.choices?.[0]?.delta?.content ??
                  "";

                if (typeof delta === "string" && delta.length) {
                  await writeEvent("delta", { type: "delta", content: delta });
                }
              } catch {
                // ignore quiet
              }
            }
          }
        }
        clearInterval(hb);
        await writeEvent("done", { type: "done" });
      } catch {
        clearInterval(hb);
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
