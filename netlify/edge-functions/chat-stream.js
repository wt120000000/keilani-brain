// netlify/edge-functions/chat-stream.js
// Edge streaming + resilient memory via Supabase REST (role/meta schema)

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  try {
    const { message = "", voice = "", sessionId = "", userId = "" } =
      await request.json().catch(() => ({}));
    if (!message || !userId) return json({ error: "missing_params" }, 400);

    const OPENAI_API_KEY   = env("OPENAI_API_KEY");
    const SUPABASE_URL     = env("SUPABASE_URL");
    const SUPABASE_SERVICE = env("SUPABASE_SERVICE_ROLE");

    const low = message.trim().toLowerCase();

    // ---- remember/save -> respond immediately and persist in background
    if (low.startsWith("remember ") || low.startsWith("save ")) {
      const content = message.replace(/^(\s*remember|\s*save)\s*/i, "").trim();
      const immediate = streamText(content ? "Saved to memory." : "I didn't catch what to remember.");
      if (content && SUPABASE_URL && SUPABASE_SERVICE) {
        persistMemory({
          SUPABASE_URL,
          SUPABASE_SERVICE,
          userId,
          sessionId,
          role: "note",
          content,
          meta: { source: "edge" },
        }).catch(() => {});
      }
      return immediate;
    }

    // ---- recall / what do you remember
    if (/^(recall|what do you remember|show memories|list memories)\b/i.test(low)) {
      let items = [];
      if (SUPABASE_URL && SUPABASE_SERVICE) {
        items = await loadMemories({
          SUPABASE_URL,
          SUPABASE_SERVICE,
          userId,
          limit: 10,
          timeoutMs: 1500,
          role: "note", // only show saved notes, not chat turns
        }).catch(() => []);
      }
      const text = items.length
        ? items.map((i) => `• ${i.content}`).join("\n")
        : "I have no memories yet.";
      return streamText(text);
    }

    // ---- normal chat: best-effort note injection
    let memoryBlock = "";
    if (SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const mems = await loadMemories({
          SUPABASE_URL,
          SUPABASE_SERVICE,
          userId,
          limit: 8,
          timeoutMs: 1200,
          role: "note",
        });
        if (mems.length) {
          memoryBlock = `Relevant notes for this user:\n${mems
            .map((m) => `- ${m.content}`)
            .join("\n")}`;
        }
      } catch {}
    }

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [
          {
            role: "system",
            content:
              `You are Keilani. Be helpful, warm, concise.\n` +
              (memoryBlock ? `${memoryBlock}\n` : "") +
              `If the user tries to save/recall memories, it's handled server-side already.`,
          },
          { role: "user", content: message },
        ],
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text().catch(() => "");
      return json({ error: "openai_error", detail: raw || upstream.statusText }, 502);
    }

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const stream = new ReadableStream({
      start(controller) {
        const reader = upstream.body.getReader();
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = dec.decode(value, { stream: true });
              for (const line of chunk.split(/\r?\n/)) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const data = t.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                try {
                  const j = JSON.parse(data);
                  const d = j.choices?.[0]?.delta?.content ?? "";
                  if (d) controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: d })}\n\n`));
                } catch {
                  controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: data })}\n\n`));
                }
              }
            }
          } catch {} finally { controller.close(); }
        })();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...cors(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return json({ error: "chat_stream_exception", detail: String(err?.message || err) }, 500);
  }
};

export const config = { path: "/api/chat-stream" };

/* ---------------- helpers ---------------- */
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(), "Content-Type": "application/json" },
  });
}
function env(k) {
  try { return (globalThis.Netlify?.env?.get?.(k) ?? Deno.env.get(k)) || ""; } catch { return ""; }
}
function streamText(text) {
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  const enc = new TextEncoder();
  (async () => {
    for (const piece of chunks(text, 64)) {
      await writer.write(enc.encode(`data: ${JSON.stringify({ delta: piece })}\n\n`));
    }
    writer.close();
  })();
  return new Response(ts.readable, {
    status: 200,
    headers: {
      ...cors(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
function* chunks(str, n) { let i=0; while (i<str.length) { yield str.slice(i,i+n); i+=n; } }

/* ---- Supabase (role/meta) with deadlines ---- */
async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), ms);
  try { return await promise(ctrl.signal); } finally { clearTimeout(t); }
}
async function persistMemory({ SUPABASE_URL, SUPABASE_SERVICE, userId, sessionId, role, content, meta }) {
  const run = (signal) =>
    fetch(`${SUPABASE_URL}/rest/v1/memory`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE,
        Authorization: `Bearer ${SUPABASE_SERVICE}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([{ user_id: userId, session_id: sessionId || null, role, content, meta }]),
      signal,
    });
  try { await withTimeout(run, 1500); } catch {}
}
async function loadMemories({ SUPABASE_URL, SUPABASE_SERVICE, userId, limit = 8, timeoutMs = 1200, role = "note" }) {
  const q = new URLSearchParams({
    user_id: `eq.${userId}`,
    order: "created_at.desc",
    limit: String(limit),
  });
  if (role) q.set("role", `eq.${role}`);
  const run = (signal) =>
    fetch(`${SUPABASE_URL}/rest/v1/memory?${q.toString()}`, {
      headers: {
        apikey: SUPABASE_SERVICE,
        Authorization: `Bearer ${SUPABASE_SERVICE}`,
        Accept: "application/json",
      },
      signal,
    }).then((r) => (r.ok ? r.json() : []));
  return withTimeout(run, timeoutMs);
}
