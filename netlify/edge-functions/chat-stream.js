// netlify/edge-functions/chat-stream.js
// Edge Runtime (Deno). Streams OpenAI chat + persists to Supabase by sessionId.
// Exposed at /api/chat-stream via [[edge_functions]] in netlify.toml.

export default async (request, context) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== "POST") {
      return j(405, { error: "method_not_allowed" });
    }

    // ----- ENV: use context.env (Edge runtime) -----
    const {
      OPENAI_API_KEY,
      OPENAI_CHAT_MODEL = "gpt-4o-mini",
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE,
      MEMORY_WINDOW = "16",
    } = env(context);

    if (!OPENAI_API_KEY) return j(500, { error: "missing_openai_key" });

    const body = await safeJson(request);
    const userText = String(body?.message || "").trim();
    const sessionId = String(body?.sessionId || "").trim();
    const voice = body?.voice ?? "";

    if (!userText) return j(400, { error: "missing_text" });
    if (!sessionId) return j(400, { error: "missing_session_id" });

    // ----- 1) Load recent history from Supabase (optional) -----
    let history = [];
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      const url =
        `${SUPABASE_URL}/rest/v1/conversation_messages` +
        `?session_id=eq.${encodeURIComponent(sessionId)}` +
        `&select=role,content` +
        `&order=ts.asc`;
      const h = await fetch(url, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Accept: "application/json",
          Prefer: "count=exact",
        },
      });
      if (h.ok) {
        history = await h.json();
      } else {
        console.warn("[edge chat-stream] supabase history err", h.status, await h.text());
      }
    }

    const windowN = clampInt(MEMORY_WINDOW, 2, 40);
    const prior = history.slice(-windowN);
    const messages = [
      { role: "system", content: baseSystemPrompt() },
      ...prior,
      { role: "user", content: userText },
    ];

    // ----- 2) OpenAI streaming request -----
    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        stream: true,
        messages,
        // omit temperature for model-compat
      }),
    });

    if (!ai.ok || !ai.body) {
      const raw = await ai.text().catch(() => "");
      console.error("[edge chat-stream] openai upstream", ai.status, raw);
      return j(502, { error: "openai_upstream_error", detail: raw });
    }

    let fullAssistant = "";

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        const reader = ai.body.getReader();

        controller.enqueue(enc.encode(`event: ready\ndata: {}\n\n`));

        const pump = async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = dec.decode(value);

            const lines = chunk.split(/\r?\n/);
            for (const line of lines) {
              if (!line) continue;
              // Forward as text/event-stream
              controller.enqueue(enc.encode(line + "\n"));

              if (line.startsWith("data: ")) {
                const payload = line.slice(6).trim();
                if (payload && payload !== "[DONE]") {
                  try {
                    const j = JSON.parse(payload);
                    const d =
                      j?.choices?.[0]?.delta?.content ??
                      j?.delta ??
                      j?.content ??
                      "";
                    if (d) fullAssistant += d;
                  } catch {
                    // ignore parse errs
                  }
                }
              }
            }
          }

          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        };

        pump().catch((e) => {
          console.error("[edge chat-stream] pump error", e);
          controller.error(e);
        });
      },
    });

    // ----- 3) Persist turn to Supabase (fire-and-forget) -----
    persistTurn({
      context,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE,
      sessionId,
      userText,
      assistantTextProvider: () => fullAssistant,
    }).catch((e) => console.warn("[edge chat-stream] persist error", e));

    return new Response(stream, {
      status: 200,
      headers: {
        ...cors(),
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    console.error("[edge chat-stream] exception", e);
    return j(500, { error: "chat_stream_exception", detail: String(e?.message || e) });
  }
};

/* ---------------- helpers ---------------- */

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With",
});

const j = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });

// Read env from Edge runtime
function env(ctx) {
  const e = ctx?.env ?? {};
  return {
    OPENAI_API_KEY: e.OPENAI_API_KEY,
    OPENAI_CHAT_MODEL: e.OPENAI_CHAT_MODEL,
    SUPABASE_URL: e.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE: e.SUPABASE_SERVICE_ROLE,
    MEMORY_WINDOW: e.MEMORY_WINDOW,
  };
}

async function safeJson(req) {
  try { return await req.json(); } catch { return null; }
}

function baseSystemPrompt() {
  return "You are Keilani. Be helpful, concise, kind, and conversational.";
}

function clampInt(v, lo, hi) {
  const n = parseInt(v ?? `${lo}`, 10);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

async function persistTurn({
  context,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  sessionId,
  userText,
  assistantTextProvider,
}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;
  // small delay so the stream can fully aggregate text
  await new Promise((r) => setTimeout(r, 10));
  const assistantText = assistantTextProvider() || "";

  const rows = [
    { session_id: sessionId, role: "user", content: userText },
    { session_id: sessionId, role: "assistant", content: assistantText },
  ];

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/conversation_messages`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  if (!resp.ok) {
    console.warn("[edge chat-stream] supabase insert err", resp.status, await resp.text());
  }
}
