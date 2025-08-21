// Ingest knowledge text into kb_chunks with OpenAI embeddings.
// Add ?dry=1 to do everything except DB insert (smoke test).

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE, OPENAI_API_KEY, EMBED_MODEL } = process.env;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "OPTIONS, POST",
};

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  try {
    const dry = (new URLSearchParams(event.queryStringParameters || {})).get("dry") === "1";

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const title = String(body?.title ?? "").trim();
    const source = String(body?.source ?? "keilani").trim() || "keilani";
    const raw = body?.text;
    const text = typeof raw === "string" ? raw : (raw == null ? "" : String(raw));

    if (!title || !text.trim()) return json(400, { ok: false, error: "Missing title or text", dry }, CORS);

    // chunk text
    const chunks = chunkText(text, { maxChars: 1400, minChars: 600, overlap: 120 });
    if (chunks.length === 0) return json(200, { ok: true, inserted: 0, dry }, CORS);

    // embed
    const embeds = await embedMany(chunks);
    if (!Array.isArray(embeds) || embeds.length !== chunks.length) throw stageErr("embed", "embedding count mismatch");

    if (dry) return json(200, { ok: true, inserted: chunks.length, dry: true }, CORS);

    // insert
    const rows = chunks.map((content, i) => ({ title, source, content, embedding: embeds[i] }));
    const ins = await supaInsert("kb_chunks", rows);
    const inserted = Array.isArray(ins) ? ins.length : (ins?.length ?? rows.length);

    return json(200, { ok: true, inserted, dry: false }, CORS);
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) }, CORS);
  }
}

// -------- helpers --------
function json(status, obj, headers={}) {
  return { statusCode: status, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(obj) };
}
function stageErr(stage, msg){ const err = new Error(`[${stage}] ${msg}`); err.stage = stage; return err; }

function chunkText(text, { maxChars = 1400, minChars = 600, overlap = 120 } = {}) {
  const norm = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trim();
  const paras = norm.split(/\n{2,}/g).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = "";

  const push = (s) => { const t = s.trim(); if (t.length) chunks.push(t); };

  for (const p of paras) {
    if ((buf + "\n\n" + p).length <= maxChars) {
      buf = buf ? (buf + "\n\n" + p) : p;
    } else {
      if (buf.length >= minChars) {
        push(buf);
        const tail = buf.slice(-overlap);
        buf = (tail + "\n\n" + p).slice(0, maxChars);
      } else {
        let start = 0;
        while (start < p.length) {
          const end = Math.min(start + maxChars, p.length);
          const piece = p.slice(start, end);
          if (piece.length >= minChars || end === p.length) push(piece);
          start = end - Math.min(overlap, piece.length);
          if (start < 0) start = 0;
          if (start >= p.length) break;
        }
        buf = "";
      }
    }
  }
  if (buf.length) push(buf);
  return chunks;
}

async function embedMany(texts) {
  if (!OPENAI_API_KEY) throw stageErr("embed", "OPENAI_API_KEY missing");
  if (!EMBED_MODEL) throw stageErr("embed", "EMBED_MODEL missing");

  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw stageErr("embed", data?.error?.message || `HTTP ${resp.status}`);

  const dims = data?.data?.[0]?.embedding?.length || 0;
  if (dims !== 1536) console.warn("Embedding dims:", dims, "— ensure DB vector(1536) matches EMBED_MODEL.");
  return (data?.data || []).map(d => d.embedding);
}

async function supaInsert(table, rows) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw stageErr("insert", "Supabase env missing");
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw stageErr("insert", data?.message || data?.error || `HTTP ${resp.status}`);
  return data;
}
