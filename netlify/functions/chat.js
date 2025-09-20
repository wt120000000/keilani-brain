// netlify/functions/chat.js
// POST { user_id?:string, message?:string, messages?:[...], emotion?:string, emotion_state?:{...} }
// -> { reply, next_emotion_state, meta }
// - Emotion state: { mood, valence[-1..1], arousal[0..1], intensity[0..1], since, decay{half_life_sec} }
// - Uses a fast heuristic sentiment to avoid extra LLM calls.
// - Adds empathy micro-structure instructions to persona.

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
    body: JSON.stringify(body),
  };
}

const OK_EMOTIONS = new Set([
  "calm", "happy", "friendly", "playful", "concerned", "curious", "confident",
  "sad", "angry"
]);

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp  = (a, b, t) => a + (b - a) * t;

function nowIso() { return new Date().toISOString(); }

function normalizeEmotionName(name) {
  const s = String(name || "").toLowerCase().trim();
  return OK_EMOTIONS.has(s) ? s : "calm";
}

function emptyAffect() {
  return {
    mood: "calm",
    valence: 0.0,     // -1..+1 (negative..positive)
    arousal: 0.2,     // 0..1   (low..high energy)
    intensity: 0.25,  // 0..1   (scales tone/prosody)
    since: nowIso(),
    decay: { half_life_sec: 600 },
  };
}

// --- Heuristic sentiment/arousal inference (cheap & fast) ---
function inferAffectFromText(text) {
  const t = (text || "").toLowerCase();

  const pos = [
    "great","good","love","awesome","excited","glad","happy","nice",
    "cool","thank you","thanks","sweet","fun","amazing","stoked"
  ];
  const neg = [
    "bad","sad","angry","upset","hate","frustrated","annoyed","worried",
    "anxious","stress","stressed","overwhelmed","tired","lonely","hurt","pissed"
  ];
  const high = ["urgent","now","asap","excited","hype","angry","furious","super","so much","very"];
  const low  = ["tired","calm","chill","slow","later","maybe","meh"];

  let score = 0, hits = 0;
  for (const k of pos) if (t.includes(k)) { score += 1; hits++; }
  for (const k of neg) if (t.includes(k)) { score -= 1; hits++; }

  // normalize valence: -1..+1
  const valence = clamp(score / Math.max(3, hits, 3), -1, 1);

  let arousal = 0.35;
  for (const k of high) if (t.includes(k)) arousal += 0.12;
  for (const k of low)  if (t.includes(k)) arousal -= 0.10;
  arousal = clamp(arousal, 0, 1);

  // confidence: magnitude + length
  const len = t.split(/\s+/).filter(Boolean).length;
  const conf = clamp(Math.abs(valence) * 0.6 + arousal * 0.2 + Math.min(1, len / 12) * 0.2, 0.15, 0.95);

  // map to mood/intensity
  const mood = pickMood(valence, arousal);
  const intensity = clamp(0.2 + Math.abs(valence) * 0.5 + arousal * 0.3, 0, 1);

  return { mood, valence, arousal, intensity, confidence: conf };
}

function pickMood(valence, arousal) {
  if (valence > 0.35 && arousal > 0.55) return "happy";
  if (valence > 0.35) return "friendly";
  if (valence > 0.1 && arousal > 0.6) return "curious";
  if (valence < -0.35 && arousal > 0.55) return "angry";
  if (valence < -0.25) return "concerned";
  if (arousal < 0.25 && valence < -0.1) return "sad";
  if (arousal > 0.65 && Math.abs(valence) < 0.2) return "curious";
  if (valence > 0.2 && arousal < 0.4) return "confident";
  return "calm";
}

// Exponential decay of affect toward baseline (0,0) between turns
function applyDecay(affect, now = Date.now()) {
  const half = (affect.decay?.half_life_sec ?? 600) * 1000;
  const sinceMs = Date.parse(affect.since || nowIso());
  const dt = Math.max(0, now - sinceMs);
  if (half <= 0 || dt <= 0) return affect;
  const lambda = Math.LN2 / half; // per ms
  const k = Math.exp(-lambda * dt); // remaining portion
  return {
    ...affect,
    valence: affect.valence * k,
    arousal: affect.arousal * k + (1 - k) * 0.25, // drift to calm energy
    intensity: affect.intensity * k,
    since: nowIso(),
  };
}

// Blend current affect with inferred affect (confidence α)
function blendAffect(base, inferred) {
  const α = clamp(inferred.confidence ?? 0.5, 0.15, 0.9);
  const valence = clamp(lerp(base.valence, inferred.valence, α), -1, 1);
  const arousal = clamp(lerp(base.arousal, inferred.arousal, α), 0, 1);
  const intensity = clamp(lerp(base.intensity, inferred.intensity, α), 0, 1);
  const mood = pickMood(valence, arousal);
  return {
    mood, valence, arousal, intensity,
    since: nowIso(),
    decay: base.decay || { half_life_sec: 600 },
  };
}

function personaFor(affect, explicitEmotion) {
  const tone = explicitEmotion ? normalizeEmotionName(explicitEmotion) : affect.mood;
  return [
    "You are Keilani — a warm, empathetic, and practical AI assistant.",
    `Adopt tone: ${tone}. Never claim feelings or consciousness; if asked, say you simulate emotion.`,
    `Current affect: mood=${affect.mood}, valence=${affect.valence.toFixed(2)}, arousal=${affect.arousal.toFixed(2)}, intensity=${affect.intensity.toFixed(2)}.`,
    "Style:",
    "- Keep replies concise (<= 120 words) unless user asks for detail.",
    "- If user shares a feeling:",
    "  1) Acknowledge in <=12 words.",
    "  2) Align perspective in <=14 words.",
    "  3) Act: offer 1–2 concrete next steps.",
    "- Be clear, concrete, and useful; avoid fluff; stay honest.",
  ].join(" ");
}

function safeParse(t) { try { return JSON.parse(t); } catch { return null; } }

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const TEMP  = Number(process.env.OPENAI_TEMPERATURE ?? 0.6);
  if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

  // Parse body
  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "invalid_json", detail: String(e.message || e) }); }

  const user_id = String(body.user_id || "global");
  const explicitEmotion = body.emotion ? normalizeEmotionName(body.emotion) : "";
  const inAffect = body.emotion_state && typeof body.emotion_state === "object"
    ? { ...emptyAffect(), ...body.emotion_state }
    : emptyAffect();

  // Decay previous state toward baseline
  const decayed = applyDecay(inAffect);

  // Accept either {message} or OpenAI-style {messages}
  let messages = Array.isArray(body.messages) ? body.messages : null;
  let userText = "";
  if (!messages) {
    userText = String(body.message || body.input || "").trim();
    if (!userText) return json(400, { error: "Missing 'message' (string)" });
    messages = [
      { role: "system", content: personaFor(decayed, explicitEmotion) },
      { role: "user",   content: userText }
    ];
  } else {
    // ensure persona present
    if (!messages.some(m => m.role === "system")) {
      messages.unshift({ role: "system", content: personaFor(decayed, explicitEmotion) });
    }
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    userText = String(lastUser?.content || "");
  }

  // Infer affect from user's latest text
  const inferred = inferAffectFromText(userText);
  const nextAffect = blendAffect(decayed, inferred);

  // Compose OpenAI payload (non-streaming)
  const payload = {
    model: MODEL,
    temperature: TEMP,
    max_tokens: 220,
    messages,
  };

  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json(502, { error: "upstream_connect_error", detail: String(e.message || e) });
  }

  const text = await resp.text();
  if (!resp.ok) {
    return json(resp.status, {
      error: "openai_error",
      detail: safeParse(text) || text,
      meta: { model: MODEL }
    });
  }

  const data = safeParse(text) || {};
  const reply = data?.choices?.[0]?.message?.content?.trim() || "";

  return json(200, {
    reply,
    next_emotion_state: nextAffect,
    meta: {
      model: MODEL,
      user_id,
      sentiment_conf: inferred.confidence,
      explicit_emotion: explicitEmotion || null
    }
  });
};
