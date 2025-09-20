// netlify/functions/tts.js
// POST { text, voice?:string, speed?:number, emotion?:string, format?:'mp3'|'wav' }
// -> audio bytes
// - Uses OpenAI TTS by default (o4-mini-tts). If ELEVEN_API_KEY+ELEVEN_VOICE_ID exist, uses ElevenLabs.
// - Applies simple emotion → prosody mapping.

const EMO = {
  calm:      { speed: 0.95, pitch: 0,   voice: "alloy" },
  happy:     { speed: 1.10, pitch: 2,   voice: "alloy" },
  friendly:  { speed: 1.05, pitch: 1,   voice: "alloy" },
  playful:   { speed: 1.15, pitch: 3,   voice: "alloy" },
  concerned: { speed: 0.98, pitch: -1,  voice: "alloy" },
  curious:   { speed: 1.05, pitch: 1,   voice: "alloy" },
  sad:       { speed: 0.90, pitch: -3,  voice: "alloy" },
  angry:     { speed: 1.00, pitch: -2,  voice: "alloy" },
};

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

exports.handler = async (event) => {
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

  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "invalid_json", detail: String(e.message || e) }); }

  const text = String(body.text || "").trim();
  if (!text) return json(400, { error: "missing_text" });

  // Map emotion → prosody defaults
  const emKey = (body.emotion || "").toLowerCase();
  const emo = EMO[emKey] || EMO.calm;

  // Caller can override
  const fmt = (body.format || "mp3").toLowerCase();
  const speed = typeof body.speed === "number" ? body.speed : emo.speed;
  const voicePref = String(body.voice || emo.voice);

  // Prefer Eleven if configured, else OpenAI TTS
  const EL_KEY = process.env.ELEVEN_API_KEY;
  const EL_VOICE = process.env.ELEVEN_VOICE_ID;

  try {
    if (EL_KEY && EL_VOICE) {
      // ---- ElevenLabs ----
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": EL_KEY,
          "Content-Type": "application/json",
          "Accept": fmt === "mp3" ? "audio/mpeg" : "audio/wav",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            style: Math.max(0, Math.min(100, 50 + (emo.pitch * 5))), // simple style tweak
            use_speaker_boost: true
          }
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return json(resp.status, { error: "tts_eleven_error", detail: errText });
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      return {
        statusCode: 200,
        headers: {
          "Content-Type": fmt === "mp3" ? "audio/mpeg" : "audio/wav",
          "Access-Control-Allow-Origin": "*",
        },
        body: buf.toString("base64"),
        isBase64Encoded: true,
      };
    }

    // ---- OpenAI TTS ----
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

    const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: voicePref,
        format: fmt,
        // OpenAI doesn't expose pitch directly; speed is honored.
        speed
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json(resp.status, { error: "tts_openai_error", detail: errText });
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        "Content-Type": fmt === "mp3" ? "audio/mpeg" : "audio/wav",
        "Access-Control-Allow-Origin": "*",
      },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return json(502, { error: "tts_exception", detail: String(e.message || e) });
  }
};
