// netlify/functions/tts.js
// POST { text: string, voiceId?: string, model_id?: string, voice_settings?: {...} }
// -> 200 { audio: "data:audio/mpeg;base64,...", meta: {...} }
// -> 4xx/5xx { error: "...", detail: <upstream json or text>, meta: {...} }

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

function j(status, body) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: JSON_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") return j(405, { error: "method_not_allowed" });

  const DEBUG = (event.queryStringParameters || {}).debug === "1";

  const rawKey =
    process.env.ELEVEN_API_KEY ||
    process.env.ELEVENLABS_API_KEY ||
    "";

  const ELEVEN_KEY = (rawKey || "").trim(); // strip any stray whitespace/newlines

  if (!ELEVEN_KEY) return j(401, { error: "missing_eleven_key" });

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return j(400, { error: "invalid_json", detail: String(e?.message || e) });
  }

  const text = (payload.text || "").trim();
  if (!text) return j(400, { error: "missing_text" });

  const userVoice = (payload.voiceId || "").trim();
  const defaultVoice = (process.env.ELEVEN_VOICE_ID || "").trim();
  const voiceId = userVoice || defaultVoice || "21m00Tcm4TlvDq8ikWAM"; // Rachel

  const model_id = payload.model_id || "eleven_multilingual_v2";
  const voice_settings = payload.voice_settings || {
    stability: 0.3,
    similarity_boost: 0.7,
  };

  try {
    // Optional sanity check: hit /voices when debug=1 so we can see upstream reason if the key is bad
    if (DEBUG) {
      const probe = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": ELEVEN_KEY },
      });
      if (!probe.ok) {
        let detail = null;
        try { detail = await probe.json(); } catch { detail = await probe.text().catch(() => null); }
        return j(401, { error: "eleven_probe_failed", detail, meta: { probeStatus: probe.status } });
      }
    }

    // Eleven streaming endpoint (MPEG)
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`;

    const eleven = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg", // important for stream endpoint
      },
      body: JSON.stringify({
        text,
        model_id,
        voice_settings,
        // Tip: enable if you want lower latency:
        // optimize_streaming_latency: 4
      }),
    });

    if (!eleven.ok) {
      // Bubble up Eleven's error (401/403/422/etc.)
      let detail = null;
      try { detail = await eleven.json(); } catch { detail = await eleven.text().catch(() => null); }
      return j(eleven.status === 401 ? 401 : 502, {
        error: "eleven_error",
        detail,
        meta: { status: eleven.status, voiceId, model_id },
      });
    }

    const buf = Buffer.from(await eleven.arrayBuffer());
    const b64 = buf.toString("base64");
    return j(200, {
      audio: `data:audio/mpeg;base64,${b64}`,
      meta: { bytes: buf.length, voiceId, model_id },
    });
  } catch (e) {
    return j(502, { error: "tts_exception", detail: String(e?.message || e) });
  }
};
