// scripts/ingest_kb.cjs
/* Usage:
   node scripts/ingest_kb.cjs './docs/**/*.{md,txt}'
   env: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE
*/
const { createClient } = require("@supabase/supabase-js");
const { glob } = require("glob");
const fs = require("fs/promises");
const path = require("path");

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPA_URL   = process.env.SUPABASE_URL;
const SUPA_KEY   = process.env.SUPABASE_SERVICE_ROLE;
const MODEL      = "text-embedding-3-small";   // 1536 dims
const TARGET_TOKENS = 700;
const OVERLAP_TOKENS = 80;

if (!OPENAI_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error("Missing env: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE");
  process.exit(1);
}

const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

function approxTokens(str) { return Math.ceil((str || "").length / 4); }
function splitIntoChunks(text, target = TARGET_TOKENS, overlap = OVERLAP_TOKENS) {
  const paras = (text || "").split(/\n{2,}/g);
  const out = [];
  let buf = [], tok = 0;

  for (const p of paras) {
    const t = approxTokens(p);
    if (tok + t > target && buf.length) {
      out.push(buf.join("\n\n"));
      const joined = buf.join("\n\n");
      const keepChars = Math.floor(overlap * 4);
      const tail = joined.slice(-keepChars);
      buf = tail ? [tail, p] : [p];
      tok = approxTokens(buf.join("\n\n"));
    } else {
      buf.push(p);
      tok += t;
    }
  }
  if (buf.length) out.push(buf.join("\n\n"));
  return out.map(s => s.trim()).filter(Boolean);
}

async function embed(text) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: text })
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.data[0].embedding;
}

async function upsertChunk({ title, source, chunk, embedding, idx, total }) {
  const { error } = await supa.from("kb_chunks").insert({
    title, source, chunk, embedding,
    metadata: { idx, total, source, title }
  });
  if (error) throw error;
}

(async function main() {
  const pattern = process.argv[2] || "./docs/**/*.{md,txt}";
  const files = await glob(pattern, { nodir: true });
  if (!files.length) {
    console.log("No files matched:", pattern);
    process.exit(0);
  }
  console.log(`Found ${files.length} file(s)`);

  for (const f of files) {
    const raw = await fs.readFile(f, "utf8");
    const clean = raw.replace(/^---[\s\S]*?---\n/, "");  // drop YAML frontmatter if present
    const title = path.basename(f);
    const source = path.relative(process.cwd(), f).replaceAll("\\", "/");
    const chunks = splitIntoChunks(clean);

    console.log(`> ${source} → ${chunks.length} chunk(s)`);
    let i = 0;
    for (const chunk of chunks) {
      i++;
      const emb = await embed(chunk);
      await upsertChunk({ title, source, chunk, embedding: emb, idx: i, total: chunks.length });
      process.stdout.write(".");
    }
    process.stdout.write("\n");
  }
  console.log("Done.");
})().catch(e => { console.error(e); process.exit(1); });
