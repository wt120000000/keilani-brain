// Minimal embedding client for Netlify Functions (Node 20 has global fetch).
// Uses OpenAI-compatible Embeddings API.
// Config:
//   OPENAI_API_KEY (required)
//   OPENAI_EMBEDDING_MODEL (optional; default text-embedding-3-small)

const DEFAULT_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn("[embeddings] OPENAI_API_KEY is not set; vector mode will be disabled.");
}

async function getEmbedding(text) {
  if (!OPENAI_API_KEY) return null;
  const body = {
    input: text,
    model: DEFAULT_MODEL
  };
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn("[embeddings] API error:", res.status, t);
    return null;
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  return Array.isArray(vec) ? vec : null;
}

module.exports = { getEmbedding };
