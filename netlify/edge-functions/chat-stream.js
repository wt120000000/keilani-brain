// Edge streaming chat with memory + persona + style rules
// Merges GLOBAL + USER persona/rules each request.
//   persona: user persona if present, else global persona
//   rules  : global rules first, then user rules (user can override vibe)
//   notes  : only user's own notes/preferences
//
// Env required (Netlify -> Site settings -> Environment variables):
//   OPENAI_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE
//
// Route: /api/chat-stream

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
    if (!OPENAI_API_KEY) return json({ error: "missing_openai_key" }, 500);

    const low = message.trim().toLowerCase();

    // -------- explicit remember/save (user note) --------
    if (low.startsWith("remember ") || low.startsWith("save ")) {
      const content = message.replace(/^(\s*remember|\s*save)\s*/i, "").trim();
      if (content && SUPABASE_URL && SUPABASE_SERVICE) {
        try {
          await persistMemory({
            SUPABASE_URL, SUPABASE_SERVICE, userId, sessionId,
            role: "note", content,
            meta: { source: "edge-explicit", ts: new Date().toISOString() },
          });
          return streamText("Saved to memory.");
        } catch {
          return streamText("I tried to save that but ran into a hiccup.");
        }
      }
      return streamText(content ? "Saved to memory." : "I didn't catch what to remember.");
    }

    // -------- explicit persona/rule updates (user-scoped) --------
    if (/^\s*set\s+persona\s*:/i.test(message)) {
      const content = message.replace(/^\s*set\s+persona\s*:/i, "").trim();
      if (content && SUPABASE_URL && SUPABASE_SERVICE) {
        await persistMemory({
          SUPABASE_URL, SUPABASE_SERVICE, userId, sessionId,
          role: "persona", content, meta: { source: "edge-persona", ts: new Date().toISOString() },
        }).catch(() => {});
        return streamText("Persona updated.");
      }
      return streamText("Give me the persona text after “set persona:”.");
    }
    if (/^\s*set\s+rule\s*:/i.test(message)) {
      const content = message.replace(/^\s*set\s+rule\s*:/i, "").trim();
      if (content && SUPABASE_URL && SUPABASE_SERVICE) {
        await persistMemory({
          SUPABASE_URL, SUPABASE_SERVICE, userId, sessionId,
          role: "rule", content, meta: { source: "edge-rule", ts: new Date().toISOString() },
        }).catch(() => {});
        return streamText("Style rule added.");
      }
      return streamText("Give me the rule after “set rule:”. Keep rules short.");
    }

    // -------- recall (user notes only) --------
    if (/^(recall|what do you remember|show memories|list memories)\b/i.test(low)) {
      let items = [];
      if (SUPABASE_URL && SUPABASE_SERVICE) {
        items = await loadMemories({
          SUPABASE_URL, SUPABASE_SERVICE, userId,
          limit: 24, timeoutMs: 1500, role: "note",
        }).catch(() => []);
      }
      const text = items.length
        ? items.map((i) => `• ${i.content}`).join("\n")
        : "I have no memories yet.";
      return streamText(text);
    }

    // -------- auto-memory extraction (preferences / facts) --------
    const autoNote = extractNote(message);
    if (autoNote && SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        const recent = await loadMemories({
          SUPABASE_URL, SUPABASE_SERVICE, userId, limit: 12, timeoutMs: 1000, role: "note",
        });
        const dup = recent.some((r) => normalize(r.content) === normalize(autoNote));
        if (!dup) {
          persistMemory({
            SUPABASE_URL, SUPABASE_SERVICE, userId, sessionId,
            role: "note", content: autoNote,
            meta: { source: "edge-auto", ts: new Date().toISOString() },
          }).catch(() => {});
        }
      } catch {}
    }

    // -------- fetch GLOBAL + USER persona/rules; USER notes --------
    let personaUser = "", personaGlobal = "";
    let rulesUser = [], rulesGlobal = [];
    let userNotes = [];

    if (SUPABASE_URL && SUPABASE_SERVICE) {
      try {
        // persona (user + global)
        const [pUser, pGlobal] = await Promise.all([
          loadExactOne({ SUPABASE_URL, SUPABASE_SERVICE, lookupUserId: userId, role: "persona" }),
          loadExactOne({ SUPABASE_URL, SUPABASE_SERVICE, lookupUserId: "global", role: "persona" }),
        ]);
        personaUser   = pUser || "";
        personaGlobal = pGlobal || "";

        // rules (global then user)
        const [rGlobal, rUser] = await Promise.all([
          loadRules({ SUPABASE_URL, SUPABASE_SERVICE, lookupUserId: "global", limit: 32 }),
          loadRules({ SUPABASE_URL, SUPABASE_SERVICE, lookupUserId: userId,    limit: 32 }),
        ]);
        rulesGlobal = rGlobal;
        rulesUser   = rUser;

        // user notes only
        userNotes = (await loadMemories({
          SUPABASE_URL, SUPABASE_SERVICE, userId, role: "note", limit: 8, timeoutMs: 800,
        })).map((x) => `- ${x.content}`);
      } catch {}
    }

    // merge persona/rules
    const persona = personaUser || personaGlobal || "";
    const rules = [...rulesGlobal, ...rulesUser];

    // -------- compact system prelude --------
    const systemPrelude = [
      "You are Keilani—warm, witty, sharp. Be brief unless asked.",
      persona ? `Persona:\n${persona}` : "",
      rules.length ? `Style rules:\n${rules.map((x)=>`• ${x}`).join("\n")}` : "",
      userNotes.length ? `User notes:\n${userNotes.join("\n")}` : "",
      "If unsure, ask a short clarifying question.",
    ].filter(Boolean).join("\n\n");

    // -------- stream OpenAI --------
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        temperature: 0.6,
        messages: [
          { role: "system", content: systemPrelude },
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
    for (const piece of chunker(text, 64)) {
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
function* chunker(str, n) { let i=0; while (i<str.length) { yield str.slice(i,i+n); i+=n; } }
function normalize(s=""){ return s.trim().toLowerCase().replace(/\s+/g," "); }

/* ---- Supabase helpers ---- */
async function withTimeout(promiseFactory, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), ms);
  try { return await promiseFactory(ctrl.signal); } finally { clearTimeout(t); }
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
  const r = await withTimeout(run, 2000);
  if (!r.ok) throw new Error(`supabase_insert_${r.status}`);
}
async function loadMemories({ SUPABASE_URL, SUPABASE_SERVICE, userId, limit = 8, timeoutMs = 1200, role }) {
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

// Return one content string for a given userId+role (latest)
async function loadExactOne({ SUPABASE_URL, SUPABASE_SERVICE, lookupUserId, role }) {
  const q = new URLSearchParams({
    user_id: `eq.${lookupUserId}`,
    role: `eq.${role}`,
    order: "created_at.desc",
    limit: "1",
  });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/memory?${q.toString()}`, {
    headers: {
      apikey: SUPABASE_SERVICE,
      Authorization: `Bearer ${SUPABASE_SERVICE}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) return "";
  const arr = await r.json();
  return arr?.[0]?.content || "";
}

// Return rule contents (array) for a userId
async function loadRules({ SUPABASE_URL, SUPABASE_SERVICE, lookupUserId, limit = 32 }) {
  const q = new URLSearchParams({
    user_id: `eq.${lookupUserId}`,
    role: "eq.rule",
    order: "created_at.desc",
    limit: String(limit),
  });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/memory?${q.toString()}`, {
    headers: {
      apikey: SUPABASE_SERVICE,
      Authorization: `Bearer ${SUPABASE_SERVICE}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) return [];
  const arr = await r.json();
  return arr.map((x) => x.content).filter(Boolean);
}

/* ---- Simple auto-memory extractor ---- */
function extractNote(text="") {
  const s = text.trim();
  const lower = s.toLowerCase();

  // "i like/love/hate/prefer X"
  const like = lower.match(/\b(i\s+(like|love|hate|prefer)\s+)(.+)$/i);
  if (like && like[3]) return titleCase(`User ${like[2]}s ${s.slice(like.index + like[1].length)}`);

  // "my favorite X is Y"
  const fav = lower.match(/\bmy\s+favorite\s+([^]+?)\s+is\s+([^]+)$/i);
  if (fav && fav[1] && fav[2]) return titleCase(`Favorite ${fav[1]} is ${fav[2]}`);

  // "i am/i'm called/named NAME"
  const name = lower.match(/\b(i\s+am|i'm)\s+([a-z][a-z\s'-]{1,40})$/i);
  if (name && name[2]) return titleCase(`User name is ${name[2]}`);

  return null;
}
function titleCase(s){ return s.replace(/\b\w/g, c=>c.toUpperCase()); }
