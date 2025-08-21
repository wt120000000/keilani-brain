// Chat with RAG: embed user message → Supabase RPC match_kb → build context → OpenAI chat.
// Query params: ?threshold=0.6&count=8  |  ?nocontext=1 to skip RAG

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE,
  OPENAI_API_KEY, OPENAI_MODEL, EMBED_MODEL,
} = process.env;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "OPTIONS, POST",
};

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  try {
    const qs = new URLSearchParams(event.queryStringParameters || {});
    const nocontext = qs.get("nocontext") === "1";
    const threshold = clamp(parseFloat(qs.get("threshold")), 0, 1, 0.6);
    const count = clamp(parseInt(qs.get("count"), 10), 1, 20, 8);

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const userId = String(body?.userId || "00000000-0000-0000-0000-000000000001");
    const message = String(body?.message || "").trim();
    if (!message) return json(400, { ok:false, error:"Missing message" }, CORS);

    if (nocontext) {
      const reply = await callOpenAI(buildMessages(userId, message, ""), { stage: "chat" });
      return json(200, { ok:true, reply, matches:[] }, CORS);
    }

    const [embedding] = await embedMany([message]);                  // [embed]
    const matches = await matchKB(embedding, { threshold, count });  // [retrieve]
    const context = buildContext(matches, 6500);
    const reply = await callOpenAI(buildMessages(userId, message, context), { stage: "chat" });

    const minimal = matches.map(m => ({ title: m.title, source: m.source, similarity: m.similarity }));
    return json(200, { ok:true, reply, matches: minimal }, CORS);
  } catch (e) {
    return json(500, { ok:false, error:String(e?.message || e) }, CORS);
  }
}

// ---- helpers ----
function json(status, obj, headers={}) {
  return { statusCode: status, headers: { "Content-Type":"application/json", ...headers }, body: JSON.stringify(obj) };
}
function clamp(n, lo, hi, def){ if (Number.isNaN(n)) return def; return Math.max(lo, Math.min(hi, n)); }

function buildContext(matches=[], budget=6500){
  let out = "";
  for (const m of matches){
    const chunk = `\n[${m.source || "kb"}] ${m.title || ""}\n${m.content || ""}\n`;
    if (out.length + chunk.length > budget) break;
    out += chunk;
  }
  return out.trim();
}

function buildMessages(userId, userMsg, context){
  const sys = [
    "You are Keilani — an adaptive AI influencer and helpful creative partner.",
    "When context is provided, use it for grounded, specific answers.",
    "Be brief, clear, and friendly. Use formatting sparingly.",
    "If the context does not contain the answer, say you don't know — then suggest a next step."
  ].join(" ");

  const msgs = [{ role:"system", content: sys }];

  if (context && context.trim()){
    msgs.push({ role:"system", content:`Knowledge Context Start >>>\n${context}\n<<< Knowledge Context End` });
  }
  msgs.push({ role:"user", content:`User: ${userId}\nMessage: ${userMsg}` });
  return msgs;
}

async function callOpenAI(messages, { stage }){
  if (!OPENAI_API_KEY) throw stageErr(stage, "OPENAI_API_KEY missing");
  if (!OPENAI_MODEL) throw stageErr(stage, "OPENAI_MODEL missing");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0.7 }),
  });
  const data = await resp.json().catch(()=> ({}));
  if (!resp.ok) throw stageErr(stage, data?.error?.message || `HTTP ${resp.status}`);
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

function stageErr(stage, msg){ const err = new Error(`[${stage}] ${msg}`); err.stage = stage; return err; }

async function embedMany(texts){
  if (!OPENAI_API_KEY) throw stageErr("embed", "OPENAI_API_KEY missing");
  if (!EMBED_MODEL) throw stageErr("embed", "EMBED_MODEL missing");

  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  const data = await resp.json().catch(()=> ({}));
  if (!resp.ok) throw stageErr("embed", data?.error?.message || `HTTP ${resp.status}`);

  const dims = data?.data?.[0]?.embedding?.length || 0;
  if (dims !== 1536) console.warn("Embedding dims:", dims, "(DB expects vector(1536)).");
  return (data?.data || []).map(d => d.embedding);
}

async function matchKB(queryEmbedding, { threshold=0.6, count=8 } = {}){
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw stageErr("retrieve","Supabase env missing");

  // Requires RPC: match_kb(query_embedding vector(1536), match_count int, match_threshold float)
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_kb`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_count: count,
      match_threshold: threshold,
    }),
  });

  const data = await resp.json().catch(()=> ({}));
  if (!resp.ok) throw stageErr("retrieve", data?.message || data?.error || `HTTP ${resp.status}`);
  return Array.isArray(data) ? data : [];
}
