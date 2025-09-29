// netlify/functions/tts.js
// POST { text: string, voiceId?: string } -> { audio: "data:audio/mpeg;base64,...", meta }
// Accepts ELEVEN_API_KEY or ELEVENLABS_API_KEY. Optional ELEVEN_VOICE_ID fallback.

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const ELEVEN_KEY =
    process.env.ELEVEN_API_KEY ||
    process.env.ELEVENLABS_API_KEY ||
    "";

  if (!ELEVEN_KEY) {
    return json(401, { error: "missing_eleven_key" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "invalid_json", detail: String(e.message || e) });
  }

  const text = (body.text || "").trim();
  const voiceId =
    (body.voiceId || "").trim() ||
    (process.env.ELEVEN_VOICE_ID || "").trim() ||
    "21m00Tcm4TlvDq8ikWAM"; // public "Rachel"

  if (!text) return json(400, { error: "missing_text" });

  try {
    // Stream-optimized ElevenLabs endpoint; returns audio/mpeg
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}/stream?optimize_streaming_latency=2`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.7, style: 0.0, use_speaker_boost: true },
      }),
    });

    // Eleven returns JSON body with an error + 401/403/4xx when unauthorized
    if (!r.ok) {
      let detail = null;
      try { detail = await r.json(); } catch { detail = await r.text(); }
      return json(r.status, { error: "eleven_error", detail, meta: { voiceId } });
    }

    const ab = await r.arrayBuffer();
    const b64 = Buffer.from(ab).toString("base64");
    return json(200, {
      audio: `data:audio/mpeg;base64,${b64}`,
      meta: { bytes: ab.byteLength, voiceId }
    });
  } catch (e) {
    return json(502, { error: "tts_exception", detail: String(e?.message || e) });
  }
};
