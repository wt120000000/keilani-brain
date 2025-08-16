// netlify/functions/ingest.mjs
import { createClient } from "@supabase/supabase-js";

// --- ENV ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small"; // 1536 dims

// --- Clients & constants ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const jsonHeaders = { "Content-Type": "application/json" };

// Tune for reliability
const MAX_CHARS = 1500;      // target ~1–1.5k chars per chunk
const CHUNK_DELAY_MS = 200;  // throttle between chunks to avoid 429s

// --- Helpers ---
function chunkText(t, size = MAX_CHARS) {
  const out = [];
  for (let i = 0; i < t.length; i += size) out.push(t.slice(i, i + size));
  return out;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  // Try to parse JSON either way so we can show helpful errors
  let j = {};
  try {
    j = await r.json();
  } catch (_) {
    /* no-op */
  }

  if (!r.ok) {
    const msg =
      j?.error?.message || `OpenAI embeddings failed (status ${r.status})`;
    throw new Error(msg);
  }
  const vec = j?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) {
    throw new Error("OpenAI returned no embedding");
  }
  return vec;
}

// 1536 zeros for dry-run to match text-embedding-3-small dims
function dummyEmbedding(len = 1536) {
  return Array.from({ length: len }, () => 0);
}

// --- Handler ---
export default async function handler(request) {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), {
        status: 405,
        headers: jsonHeaders,
      });
    }

    const url = new URL(request.url);
    const dry = url.searchParams.get("dry") === "1";

    // Parse body and coerce text to a string
    const body = await request.json();
    let { title = "untitled", source = "manual", text } = body || {};

    if (Array.isArray(text)) {
      text = text.join("\n"); // arrived as lines
    } else if (text == null) {
      text = ""; // null/undefined
    } else if (typeof text !== "string") {
      text = String(text); // numbers/objects → string
    }

    // Normalize line endings
    text = text.replace(/\r\n/g, "\n");

    if (!text || !text.trim()) {
      return new Response(
        JSON.stringify({ error: "No text (empty after coercion)" }),
        { status: 400, headers: jsonHeaders }
      );
    }

    // Chunk the text
    const chunks = chunkText(text);
    const rows = [];

    // For each chunk, get embedding (or dummy) and stage row
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      try {
        const e = dry ? dummyEmbedding() : await embed(c);
        rows.push({ title, source, chunk: c, embedding: e });
        if (!dry) await sleep(CHUNK_DELAY_MS);
      } catch (err) {
        // Be explicit about which chunk failed
        return new Response(
          JSON.stringify({
            error: `Chunk ${i + 1}/${chunks.length} failed: ${
              err?.message || String(err)
            }`,
          }),
          { status: 500, headers: jsonHeaders }
        );
      }
    }

    // Insert into Supabase
    const { data, error } = await supabase
      .from("kb_chunks")
      .insert(rows)
      .select("id");
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, inserted: data.length, dry }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
