// netlify/edge-functions/chat-stream.js
// Route(s) in netlify.toml:
//   [[edge_functions]] path="/api/chat-stream" function="chat-stream"
//   [[edge_functions]] path="/.netlify/functions/chat-stream" function="chat-stream"   # compat

export default async (req, ctx) => {
  try {
    const { userId = null, sessionId = null, message = "", voice = "", history = [] } =
      await req.json().catch(() => ({}));

    if (!message || !sessionId) {
      return json({ error: "missing_params" }, 400);
    }

    const OPENAI_API_KEY = env("OPENAI_API_KEY");
    const SB_URL = env("SUPABASE_URL");
    const SB_SERVICE = env("SUPABASE_SERVICE_ROLE");
    if (!OPENAI_API_KEY) return json({ error: "missing_openai_key" }, 500);
    if (!SB_URL || !SB_SERVICE) return json({ error: "missing_supabase_env" }, 500);

    // 1) Load last N from Supabase (user takes precedence, else session)
    const past = await loadMemory({ SB_URL, SB_SERVICE, userId, sessionId, limit: 24 });

    // Optionally merge in client-provided 'history' (we keep it last to prefer server truth)
    const prior = [...past, ...normalizeHistory(history)];

    // 2) Build messages for OpenAI
    const messages = [
      {
        role: "system",
        content:
          "You are Keilani. Be helpful, warm, concise. If the user sounds casual, match their vibe.",
      },
      ...prior,
      { role: "user", content: message },
    ];

    // 3) Stream from OpenAI and tee to client while accumulating reply
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      stream: true,
      messages,
    });

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text().catch(() => "");
      return json({ error: "openai_upstream_error", detail: raw }, upstream.status);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let assistantText = "";

    const stream = new ReadableStream({
      start(controller) {
        const send = (obj) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });

            // Parse OpenAI's SSE (lines starting with "data:")
            for (const line of chunk.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (data === "[DONE]") continue;

              try {
                const ev = JSON.parse(data);
                const delta =
                  ev.choices?.[0]?.delta?.content ??
                  ev.choices?.[0]?.text ??
                  "";
                if (delta) {
                  assistantText += delta;
                  send({ delta });
                }
              } catch {
                // Pass-through unknown lines
                send({ delta: data });
              }
            }
          }
          // Done
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
          controller.close();
        };

        pump().catch((e) => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: "stream_exception", detail: String(e) })}\n\n`
            )
          );
          controller.close();
        });
      },
      async cancel() {},
    });

    // 4) Persist to Supabase (fire-and-forget)
    persistMemory({
      SB_URL,
      SB_SERVICE,
      userId,
      sessionId,
      userMsg: message,
      assistantMsg: assistantText,
    }).catch(() => {});

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return json({ error: "chat_stream_exception", detail: String(e) }, 500);
  }
};

/* ---------------- helpers ---------------- */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

// Netlify Edge allows Deno.env.get; on other variants Netlify.env.get()
function env(k) {
  try {
    return (globalThis.Netlify?.env?.get?.(k) ?? Deno.env.get(k)) || "";
  } catch {
    return "";
  }
}

function normalizeHistory(h = []) {
  // Expect array like [{role:"user","content":"..."}]
  return (Array.isArray(h) ? h : []).filter(
    (m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant")
  );
}

async function sbFetch({ SB_URL, SB_SERVICE, path, method = "GET", body, query }) {
  const url = new URL(`${SB_URL}/rest/v1/${path}`);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  return fetch(url, {
    method,
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function loadMemory({ SB_URL, SB_SERVICE, userId, sessionId, limit = 24 }) {
  // Prefer user thread if provided; otherwise session thread
  const filter = userId
    ? { select: "*", order: "created_at.desc", limit, user_id: `eq.${userId}` }
    : { select: "*", order: "created_at.desc", limit, session_id: `eq.${sessionId}` };

  const q = {
    select: filter.select,
    order: filter.order,
    limit: String(limit),
    ...(userId ? { user_id: filter.user_id } : { session_id: filter.session_id }),
  };

  const resp = await sbFetch({
    SB_URL,
    SB_SERVICE,
    path: "memory",
    query: q,
  });

  if (!resp.ok) return [];
  const rows = await resp.json().catch(() => []);
  // Reverse back to chronological order and convert to OpenAI format
  return rows
    .reverse()
    .map((r) => ({ role: r.role, content: r.content }))
    .filter((m) => m.role === "user" || m.role === "assistant");
}

async function persistMemory({ SB_URL, SB_SERVICE, userId, sessionId, userMsg, assistantMsg }) {
  const rows = [
    { user_id: userId, session_id: sessionId, role: "user", content: userMsg },
    { user_id: userId, session_id: sessionId, role: "assistant", content: assistantMsg ?? "" },
  ];
  await sbFetch({ SB_URL, SB_SERVICE, path: "memory", method: "POST", body: rows });
}
