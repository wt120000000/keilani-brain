// netlify/functions/tts.js
// POST { text, voice?, emotion?: { stability?, similarity?, style? } } -> MP3 bytes
// ElevenLabs proxy with strict clamping 0..1 for voice_settings.

const fetch = globalThis.fetch; // Node 18+
const enc = new TextEncoder();

function clamp01(v, fallback = 0.5) {
  const n = typeof v === "string" ? parseFloat(v) : (typeof v === "number" ? v : NaN);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      },
      body: ""
    };
  }
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
  const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Alloy default
  if (!ELEVEN_API_KEY) return json(500, { error: "missing_eleven_key" });

  // Parse input
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "invalid_json", detail: String(e?.message || e) });
  }

  const text = (body.text || "").toString().trim();
  if (!text) return json(400, { error: "missing_text" });

  const voice = (body.voice || "").toString().trim() || ELEVEN_VOICE_ID;
  const emotion = body.emotion || {};
  // HARD CLAMP: always in [0,1]
  const stability  = clamp01(emotion.stability,  0.55);
  const similarity = clamp01(emotion.similarity, 0.75);
  const style      = clamp01(emotion.style,      0.50);

  // ElevenLabs v1 TTS
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`;
  const payload = {
    text,
    model_id: "eleven_monolingual_v1", // or your preferred model
    voice_settings: {
      stability,          // 0..1
      similarity_boost: similarity, // 0..1
      style,              // 0..1 (IMPORTANT: DO NOT MULTIPLY)
      use_speaker_boost: true
    }
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify(payload)
    });

    // If ElevenLabs returns JSON (error), bubble it up
    const ct = resp.headers.get("content-type") || "";
    if (!resp.ok || ct.includes("application/json")) {
      const errText = await resp.text().catch(() => "");
      let detail;
      try { detail = JSON.parse(errText); } catch { detail = errText; }
      return json(resp.status, { error: "tts_eleven_error", detail });
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      },
      body: buf.toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) {
    return json(502, { error: "tts_exception", detail: String(e?.message || e) });
  }
};
