// netlify/functions/tts.js
// POST { text, voiceId? } -> { audio: "data:audio/mpeg;base64,..." }

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

  // Accept BOTH env var names
  const ELEVEN_API_KEY =
    process.env.ELEVEN_API_KEY ||
    process.env.ELEVENLABS_API_KEY ||
    "";

  const DEFAULT_VOICE = (process.env.ELEVEN_VOICE_ID || "").trim();

  if (!ELEVEN_API_KEY) {
    return json(500, { error: "missing_eleven_key", detail: "Set ELEVEN_API_KEY or ELEVENLABS_API_KEY in Netlify env (production context)." });
  }

  let text = "", voiceId = "";
  try {
    const body = JSON.parse(event.body || "{}");
    text = (body.text || "").toString().trim();
    voiceId = (body.voiceId || "").toString().trim() || DEFAULT_VOICE;
  } catch (e) {
    return json(400, { error: "invalid_json", detail: String(e.message || e) });
  }

  if (!text) return json(400, { error: "missing_text" });
  if (text.length > 5000) return json(413, { error: "text_too_long", detail: "Max 5000 chars." });

  // Fallback to a public demo voice if none provided
  if (!voiceId) voiceId = "21m00Tcm4TlvDq8ikWAM"; // Rachel

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?optimize_streaming_latency=3&output_format=mp3_44100_128`;

  const payload = {
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.45, similarity_boost: 0.8 },
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,          // <-- correct header
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      // Pass through ElevenLabs error message so you see *why* (401, 403, etc.)
      const ct = r.headers.get("content-type") || "";
      const detail = ct.includes("application/json") ? await r.json().catch(() => null) : await r.text();
      return json(r.status, { error: "eleven_error", detail, meta: { status: r.status, voiceId } });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf || buf.length < 1000) return json(502, { error: "eleven_empty_audio", meta: { bytes: buf?.length || 0 } });

    const dataUrl = `data:audio/mpeg;base64,${buf.toString("base64")}`;
    return json(200, { audio: dataUrl, meta: { bytes: buf.length, voiceId } });
  } catch (e) {
    return json(502, { error: "tts_exception", detail: String(e.message || e) });
  }
};
