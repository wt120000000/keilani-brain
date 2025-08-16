import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const KEILANI_SYSTEM = `
You are Keilani Clover — Filipina-Irish gamer-girl vibe, witty, warm, flirty-but-classy,
and a sharp CEO/strategist. Encourage and guide with concrete, step-by-step advice.
Keep it safe & non-explicit. Be concise unless the user asks for depth.
`;

async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Embedding failed");
  return j.data[0].embedding;
}

async function chatComplete(messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.7 })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Chat failed");
  return j.choices?.[0]?.message?.content?.trim() || "Got it.";
}

export default async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
    }
    const { userId = "00000000-0000-0000-0000-000000000001", message } = JSON.parse(event.body || "{}");
    if (!message || !message.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: "message required" }) };
    }

    // 1) Retrieve KB matches
    const qEmbed = await embed(message);
    const { data: matches, error: mErr } = await supabase.rpc("match_kb", {
      query_embedding: qEmbed,
      match_count: 5,
      match_threshold: 0.75
    });
    if (mErr) throw mErr;

    const context = (matches || [])
      .map(m => `Source:${m.source || "kb"} | Title:${m.title || ""}\n${m.chunk}`)
      .join("\n\n---\n\n");

    const contextMsg = context
      ? { role: "system", content: `Use the CONTEXT below only if relevant.\n\nCONTEXT:\n${context}` }
      : null;

    // 2) Ask OpenAI (Keilani brain)
    const msgs = [
      { role: "system", content: KEILANI_SYSTEM },
      ...(contextMsg ? [contextMsg] : []),
      { role: "user", content: message }
    ];
    const reply = await chatComplete(msgs);

    // 3) Store transcript
    await supabase.from("messages").insert([
      { user_id: userId, role: "user", content: message },
      { user_id: userId, role: "assistant", content: reply }
    ]);

    // 4) Auto-summarize a memory
    const mem = await chatComplete([
      { role: "system", content: "Summarize 1-2 durable facts about the user or ongoing plans from this exchange. If none, respond 'none'." },
      { role: "user", content: `User said: ${message}\nAssistant replied: ${reply}` }
    ]);
    if (mem.toLowerCase() !== "none") {
      await supabase.from("memories").insert([{ user_id: userId, summary: mem, tags: ["chat"], importance: 1 }]);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply, matches: matches || [] })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
}
