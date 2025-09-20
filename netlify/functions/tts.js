// netlify/functions/tts.js
// POST { text, voice?:string, speed?:number, emotion?:string, emotion_state?:{...}, format?:'mp3'|'wav' }
// -> audio bytes (base64), Content-Type audio/*
// - Prosody mapping from mood+intensity → speed (+voice choice).
// - Uses ElevenLabs if ELEVEN_API_KEY & ELEVEN_VOICE_ID exist, else OpenAI.

const EMO_BASE = {
  calm:      { speed: 0.95, voice: "alloy" },
  happy:     { speed: 1.10, voice: "alloy" },
  friendly:  { speed: 1.05, voice: "alloy" },
  playful:   { speed: 1.15, voice: "alloy" },
  concerned: { speed: 0.98, voice: "alloy" },
  curious:   { speed: 1.06, voice: "alloy" },
  confident: { speed: 1.03, voice: "alloy" },
  sad:       { speed: 0.90, voice: "alloy" },
  angry:     { speed: 1.00, voice: "alloy" },
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

function normalizeEmotionName(name) {
  const s = String(name || "").toLowerCase().trim();
  return EMO_BASE[s] ? s : "calm";
}

function prosodyFromAffect(emotion, affect) {
  // scale speed by intensity a bit (±7%)
  const base = EMO_BASE[emotion] || EMO_BASE.calm;
  const intensity = Number(affect?.intensity ?? 0.25);
  const speed = Math.max(0.8, Math.min(1.25, base.speed + (intensity - 0.25) * 0.14));
  return { speed, voice: base.voice };
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

  const fmt = (body.format || "mp3").toLowerCase();
  // prefer explicit emotion name; else use mood from emotion_state; fallback calm
  const emotionName = body.emotion
    ? normalizeEmotionName(body.emotion)
    : normalizeEmotionName(body.emotion_state?.mood || "calm");

  const prosody = prosodyFromAffect(emotionName, body.emotion_state);
  const speed = typeof body.speed === "number" ? body.speed : prosody.speed;
  const voice = String(body.voice || prosody.voice);

  // Prefer Eleven if configured
  const EL_KEY = process.env.ELEVEN_API_KEY;
  const EL_VOICE = process.env.ELEVEN_VOICE_ID;

  try {
    if (EL_KEY && EL_VOICE) {
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
            stability: 0.55,
            similarity_boost: 0.8,
            style: Math.round(50 + (body.emotion_state?.intensity ?? 0.25) * 40),
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

    // OpenAI TTS
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
        voice,
        format: fmt,
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
