// netlify/functions/tts.js
// POST { text, voiceId?, model_id?, stability?, similarity_boost? }
// Returns: { audio: "data:audio/mpeg;base64,..." } on 200
// On error: { error: "eleven_error", detail: <upstream json/text>, meta: {...} } with the upstream status code.

const okCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "OPTIONS, POST",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: okCors, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: okCors,
        body: JSON.stringify({ error: "method_not_allowed" }),
      };
    }

    // Accept either env var name
    const rawA = process.env.ELEVEN_API_KEY || "";
    const rawB = process.env.ELEVENLABS_API_KEY || "";
    const XI_API_KEY = (rawA || rawB || "").trim();
    if (!XI_API_KEY) {
      return {
        statusCode: 500,
        headers: okCors,
        body: JSON.stringify({ error: "missing_api_key" }),
      };
    }

    const debug = /(^|[?&])debug=1(&|$)/.test(event.rawUrl || "");
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return {
        statusCode: 400,
        headers: okCors,
        body: JSON.stringify({ error: "invalid_json" }),
      };
    }

    const text = (body.text || "").toString();
    if (!text) {
      return {
        statusCode: 400,
        headers: okCors,
        body: JSON.stringify({ error: "missing_text" }),
      };
    }

    // Pick voice: request > env > hard fallback to a free premade (Sarah)
    const voiceIdEnv = (process.env.ELEVEN_VOICE_ID || "").trim();
    const voiceId =
      (body.voiceId || "").trim() ||
      voiceIdEnv ||
      "EXAVITQu4vr4xnSDxMaL"; // Sarah

    // Model fallback that is broadly allowed
    const model_id =
      (body.model_id || "").trim() ||
      process.env.ELEVEN_TTS_MODEL ||
      "eleven_turbo_v2";

    // Optional voice settings passthrough
    const stability = body.stability;
    const similarity_boost = body.similarity_boost;
    const style = body.style;
    const use_speaker_boost = body.use_speaker_boost;

    // Eleven streaming synth endpoint
    const qs = new URLSearchParams({
      optimize_streaming_latency: (body.optimize_streaming_latency ?? 2).toString(),
      output_format: body.output_format || "mp3_44100_128",
    });

    const synthUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}/stream?${qs.toString()}`;

    const payload = {
      text,
      model_id,
      voice_settings: {
        ...(stability !== undefined ? { stability } : {}),
        ...(similarity_boost !== undefined ? { similarity_boost } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(use_speaker_boost !== undefined ? { use_speaker_boost } : {}),
      },
    };

    // Remove empty voice_settings if we didn’t set anything
    if (Object.keys(payload.voice_settings).length === 0) {
      delete payload.voice_settings;
    }

    const r = await fetch(synthUrl, {
      method: "POST",
      headers: {
        "xi-api-key": XI_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(payload),
    });

    // If Eleven errors, surface the exact body & code
    if (!r.ok) {
      let detail;
      try {
        detail = await r.json();
      } catch {
        try {
          detail = await r.text();
        } catch {
          detail = "<no-body>";
        }
      }
      const code = r.status || 500;
      return {
        statusCode: code,
        headers: okCors,
        body: JSON.stringify({
          error: "eleven_error",
          detail,
          meta: { status: code, voiceId, model_id, synthUrl: debug ? synthUrl : undefined },
        }),
      };
    }

    // Convert audio stream -> base64 data URL
    const buf = Buffer.from(await r.arrayBuffer());
    const b64 = buf.toString("base64");
    const dataUrl = `data:audio/mpeg;base64,${b64}`;

    return {
      statusCode: 200,
      headers: okCors,
      body: JSON.stringify({ audio: dataUrl, meta: { voiceId, model_id } }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: okCors,
      body: JSON.stringify({
        error: "server_error",
        detail: String(err?.message || err),
      }),
    };
  }
};
