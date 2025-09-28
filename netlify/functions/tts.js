// ElevenLabs TTS proxy (returns base64 data URL). Low-deps, CORS-friendly.
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: "method_not_allowed" }) };
  }

  const { text = "", voiceId, modelId = "eleven_multilingual_v2" } = safeJson(event.body || "{}");

  // Accept any of the common var names
  const KEY =
    process.env.ELEVENLABS_API_KEY ||
    process.env.ELEVEN_API_KEY ||
    process.env.XI_API_KEY;

  const VOICE =
    (voiceId || "").trim() ||
    process.env.ELEVEN_VOICE_ID ||
    "21m00Tcm4TlvDq8ikWAM"; // fallback voice

  if (!KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "missing_eleven_key" }) };
  if (!String(text).trim()) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "missing_text" }) };

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE)}/stream`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      })
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "tts_upstream_error", detail: t }) };
    }

    const ab = await r.arrayBuffer();
    const b64 = Buffer.from(ab).toString("base64");

    return {
      statusCode: 200,
      headers: { ...cors(), "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ audio: `data:audio/mpeg;base64,${b64}` })
    };
  } catch (e) {
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "tts_exception", detail: String(e?.message || e) }) };
  }
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With"
  };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
