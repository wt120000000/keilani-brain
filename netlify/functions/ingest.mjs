import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const jsonHeaders = { "Content-Type": "application/json" };

async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Embedding failed");
  return j.data[0].embedding;
}

function chunkText(t, size = 3500) {
  const chunks = [];
  for (let i = 0; i < t.length; i += size) chunks.push(t.slice(i, i + size));
  return chunks;
}

export default async function handler(request) {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: jsonHeaders });
    }

    const { title = "untitled", source = "manual", text } = await request.json();
    if (!text || !text.trim()) {
      return new Response(JSON.stringify({ error: "No text" }), { status: 400, headers: jsonHeaders });
    }

    const chunks = chunkText(text);
    const rows = [];
    for (const c of chunks) {
      const e = await embed(c);
      rows.push({ title, source, chunk: c, embedding: e });
    }

    const { data, error } = await supabase.from("kb_chunks").insert(rows).select("id");
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, inserted: data.length }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err.message || err) }), { status: 500, headers: jsonHeaders });
  }
}
