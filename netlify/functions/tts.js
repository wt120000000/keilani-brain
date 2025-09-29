// netlify/functions/tts.js
// POST { text: string, voiceId?: string, model_id?: string, voice_settings?: {...} }
// -> { audio: "data:audio/mpeg;base64,...", meta: {...} }

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
  // CORS preflight
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

  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

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
    return json(400, { error: "invalid_json", detail: String(e?.message || e) });
  }

  const text = (body.text || "").trim();
  const userVoice = (body.voiceId || "").trim();
  const defaultVoice = (process.env.ELEVEN_VOICE_ID || "").trim(); // optional
  const voiceId = userVoice || defaultVoice || "21m00Tcm4TlvDq8ikWAM"; // “Rachel”

  if (!text) {
    return json(400, { error: "missing_text" });
  }

  // Optional model + voice settings (safe defaults if none provided)
  const model_id = body.model_id || "eleven_multilingual_v2";
  const voice_settings = body.voice_settings || {
    stability: 0.3,
    similarity_boost: 0.7,
  };

  try {
    // Eleven streaming endpoint (returns audio/mpeg)
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}/stream`;

    const elevenResp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_KEY, // <- must be exactly this header
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id, voice_settings }),
    });

    // If Eleven returns an error, try to surface their JSON
    if (!elevenResp.ok) {
      let detail = null;
      try {
        detail = await elevenResp.json();
      } catch {
        try {
          detail = await elevenResp.text();
        } catch {
          detail = null;
        }
      }
      // 401/403/4xx from Eleven -> pass through 401 to the client (matches your logs)
      const status = elevenResp.status === 401 ? 401 : 502;
      return json(status, {
        error: "eleven_error",
        detail,
        meta: { status: elevenResp.status, voiceId, model_id },
      });
    }

    // Convert audio stream to base64 data URL
    const arrayBuf = await elevenResp.arrayBuffer();
    const b64 = Buffer.from(arrayBuf).toString("base64");
    const dataUrl = `data:audio/mpeg;base64,${b64}`;

    return json(200, {
      audio: dataUrl,
      meta: {
        bytes: b64.length * 0.75, // approx
        voiceId,
        model_id,
      },
    });
  } catch (e) {
    return json(502, { error: "tts_exception", detail: String(e?.message || e) });
  }
};
