// netlify/edge-functions/chat-stream.js
// Edge Runtime: streams OpenAI chat completion and persists conversation
// to Supabase keyed by sessionId. Route is configured in netlify.toml:
//   [[edge_functions]]
//   path = "/api/chat-stream"
//   function = "chat-stream"

export default async (request, context) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    const {
      OPENAI_API_KEY,
      OPENAI_CHAT_MODEL = "gpt-4o-mini",
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE,
      MEMORY_WINDOW = "16", // number of last messages to hydrate
    } = env();

    if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      console.warn("[chat-stream] Missing Supabase env; will run stateless.");
    }

    const body = await safeJson(request);
    const userText = String(body?.message || "").trim();
    const sessionId = String(body?.sessionId || "").trim();
    const voice = (body?.voice ?? "");

    if (!userText) return json(400, { error: "missing_text" });
    if (!sessionId) return json(400, { error: "missing_session_id" });

    // ----- 1) Pull recent history from Supabase (server-side, using service key)
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
        console.warn("[chat-stream] supabase history error", await h.text());
      }
    }

    // Keep last N messages (role/content pairs), then add current user msg
    const windowN = clampInt(MEMORY_WINDOW, 2, 40);
    const prior = history.slice(-windowN);
    const messages = [
      { role: "system", content: baseSystemPrompt() },
      ...prior,
      { role: "user", content: userText },
    ];

    // ----- 2) Stream from OpenAI
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        stream: true,
        messages,
        // temperature intentionally omitted for cross-model compatibility
      }),
    });

    if (!openaiResp.ok || !openaiResp.body) {
      const raw = await openaiResp.text().catch(() => "");
      console.error("[chat-stream] openai error", openaiResp.status, raw);
      return json(502, { error: "openai_upstream_error", detail: raw });
    }

    // We'll capture the streamed assistant text to persist after the stream ends
    let fullAssistant = "";

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const reader = openaiResp.body.getReader();

        // SSE-style "data: {json}\n\n"
        controller.enqueue(encoder.encode(`event: ready\ndata: {}\n\n`));

        const pump = async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);

            // forward raw chunks as text/event-stream lines
            // also aggregate assistant tokens from "delta" fields
            const lines = chunk.split(/\r?\n/);
            for (const line of lines) {
              if (!line) continue;
              controller.enqueue(encoder.encode(line + "\n"));
              // try parse assistant deltas for local aggregation
              if (line.startsWith("data: ")) {
                const payload = line.slice(6).trim();
                if (payload && payload !== "[DONE]") {
                  try {
                    const j = JSON.parse(payload);
                    const d = j.choices?.[0]?.delta?.content || j.delta || j.content || "";
                    if (d) fullAssistant += d;
                  } catch { /* ignore */ }
                }
              }
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };

        pump().catch((e) => {
          console.error("[chat-stream] stream pump error", e);
          controller.error(e);
        });
      },
    });

    // Fire-and-forget persist (don’t block the stream)
    persistTurn({
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE,
      sessionId,
      userText,
      assistantTextProvider: () => fullAssistant, // evaluated after stream finishes
    }).catch((e) => console.warn("[chat-stream] persist error", e));

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
    console.error("[chat-stream] exception", e);
    return json(500, { error: "chat_stream_exception", detail: String(e?.message || e) });
  }
};

/* ----------------------- helpers ----------------------- */

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
});

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });

const env = () => ({
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE: process.env.SUPABASE_SERVICE_ROLE,
  MEMORY_WINDOW: process.env.MEMORY_WINDOW,
});

async function safeJson(req) {
  try { return await req.json(); } catch { return null; }
}

function baseSystemPrompt() {
  return "You are Keilani. Be helpful, concise, kind, and conversational.";
}

function clampInt(v, lo, hi) {
  const n = Math.max(lo, Math.min(hi, parseInt(v || `${lo}`, 10)));
  return Number.isFinite(n) ? n : lo;
}

/**
 * Persist both user and assistant messages to Supabase.
 * We insert them as two rows in a single RPC (bulk insert via PostgREST).
 */
async function persistTurn({ SUPABASE_URL, SUPABASE_SERVICE_ROLE, sessionId, userText, assistantTextProvider }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;

  // small delay to ensure stream closed and assistant text accumulated
  await new Promise((r) => setTimeout(r, 10));
  const assistantText = assistantTextProvider() || "";

  const rows = [
    { session_id: sessionId, role: "user",      content: userText },
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
    const raw = await resp.text();
    console.warn("[chat-stream] supabase insert error", resp.status, raw);
  }
}
