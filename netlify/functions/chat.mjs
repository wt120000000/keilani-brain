// netlify/functions/chat.mjs
import { createClient } from "@supabase/supabase-js";

// --- ENV ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PRIMARY_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // safe default
const FALLBACK_MODEL = "gpt-4o-mini"; // fallback stays mini to ensure availability
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small"; // 1536 dims

// --- Clients & constants ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const jsonHeaders = { "Content-Type": "application/json" };

const KEILANI_SYSTEM = `
You are Keilani Clover — Filipina-Irish gamer-girl vibe, warm, witty, flirty-but-classy,
and a sharp CEO/strategist. Use bullets and checklists. Be concrete and step-by-step.
Keep it safe & non-explicit. Be concise unless the user asks for depth.
`;

function toStr(v, fallback = "") {
  if (v == null) return fallback;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join("\n");
  try { return String(v); } catch { return fallback; }
}

// ---- OpenAI helpers ----
async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text })
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j?.error?.message || `OpenAI embeddings failed (status ${r.status})`);
  const vec = j?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error("OpenAI returned no embedding");
  return vec;
}

async function chatOnce(messages, model) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.6 })
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j?.error?.message || `OpenAI chat failed (status ${r.status})`);
  return j.choices?.[0]?.message?.content?.trim() || "Got it.";
}

async function chatWithFallback(messages) {
  try {
    return await chatOnce(messages, PRIMARY_MODEL);
  } catch (e1) {
    // fallback if the primary model is unavailable on the account
    try {
      return await chatOnce(messages, FALLBACK_MODEL);
    } catch (e2) {
      throw new Error(`chat failed: primary(${PRIMARY_MODEL}): ${e1.message}; fallback(${FALLBACK_MODEL}): ${e2.message}`);
    }
  }
}

// ---- Handler ----
export default async function handler(request) {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: jsonHeaders });
    }

    const url = new URL(request.url);
    const skipContext = url.searchParams.get("nocontext") === "1";
    const matchThreshold = parseFloat(url.searchParams.get("threshold") ?? "0.6");
    const matchCount = parseInt(url.searchParams.get("count") ?? "8", 10);

    const body = await request.json().catch(() => ({}));
    const userId = toStr(body.userId, "00000000-0000-0000-0000-000000000001");
    let message = toStr(body.message, "").replace(/\r\n/g, "\n");
    if (!message.trim()) {
      return new Response(JSON.stringify({ error: "message required" }), { status: 400, headers: jsonHeaders });
    }

    // 1) Retrieval (if not skipped)
    let matches = [];
    let context = "";
    if (!skipContext) {
      let qEmbed;
      try {
        qEmbed = await embed(message);
      } catch (err) {
        return new Response(JSON.stringify({ error: `embed stage failed: ${err.message}` }), { status: 500, headers: jsonHeaders });
      }

      try {
        const { data, error } = await supabase.rpc("match_kb", {
          query_embedding: qEmbed,
          match_count: matchCount,
          match_threshold: matchThreshold
        });
        if (error) throw error;
        matches = data || [];
        context = matches
          .map(m => `Source:${m.source || "kb"} | Title:${m.title || ""}\n${m.chunk}`)
          .join("\n\n---\n\n");
      } catch (err) {
        const hint = " (check match_kb function exists and expects vector(1536))";
        return new Response(JSON.stringify({ error: `retrieval stage failed: ${err.message}${hint}` }), { status: 500, headers: jsonHeaders });
      }
    }

    const contextMsg = context
      ? { role: "system", content: `Use the CONTEXT below only if relevant.\n\nCONTEXT:\n${context}` }
      : null;

    const msgs = [
      { role: "system", content: KEILANI_SYSTEM },
      ...(contextMsg ? [contextMsg] : []),
      { role: "user", content: message }
    ];

    // 2) Chat with fallback
    let reply;
    try {
      reply = await chatWithFallback(msgs);
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
    }

    // 3) Store transcript (best-effort)
    try {
      await supabase.from("messages").insert([
        { user_id: userId, role: "user", content: message },
        { user_id: userId, role: "assistant", content: reply }
      ]);
    } catch { /* ignore */ }

    // 4) Auto memory (best-effort)
    try {
      const mem = await chatWithFallback([
        { role: "system", content: "Summarize 1–2 durable facts about the user or ongoing plans from this exchange. If none, respond 'none'." },
        { role: "user", content: `User said: ${message}\nAssistant replied: ${reply}` }
      ]);
      if (mem && mem.toLowerCase() !== "none") {
        await supabase.from("memories").insert([{ user_id: userId, summary: mem, tags: ["chat"], importance: 1 }]);
      }
    } catch { /* ignore */ }

    return new Response(JSON.stringify({ reply, matches }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500, headers: jsonHeaders });
  }
}
