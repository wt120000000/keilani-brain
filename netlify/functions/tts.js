// netlify/functions/tts.js
// POST { text, voiceId?, modelId?, latency?, stability?, similarity?, style?, outputFormat? } -> audio/mpeg (binary)

const makeBinary = (buf, extra = {}) => ({
  statusCode: 200,
  isBase64Encoded: true,
  headers: {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  },
  body: buf.toString("base64"),
});

const makeErr = (status, msg, extra = {}) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  },
  body: JSON.stringify({ error: msg }),
});

exports.handler = async (event) => {
  // ---- CORS preflight
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

  // ---- Method check
  if (event.httpMethod !== "POST") {
    return makeErr(405, "Method Not Allowed");
  }

  // ---- API key (support both env names)
  const API_KEY =
    process.env.ELEVENLABS_API_KEY ||
    process.env.ELEVEN_API_KEY ||
    "";

  if (!API_KEY) {
    return makeErr(500, "Missing ELEVENLABS_API_KEY (or ELEVEN_API_KEY)");
  }

  try {
    const input = JSON.parse(event.body || "{}");

    const text = (input.text || "").toString().trim();
    if (!text) return makeErr(400, "Missing text");

    // Voice resolution:
    //  1) request body voiceId
    //  2) env ELEVEN_VOICE_ID
    const voiceId = (input.voiceId || process.env.ELEVEN_VOICE_ID || "").trim();
    if (!voiceId) {
      return makeErr(400, "Missing voiceId (and ELEVEN_VOICE_ID fallback not set)");
    }

    // Optional tuning
    const modelId = (input.modelId || "eleven_monolingual_v1").toString();
    // 0 (highest quality) through 4 (lowest latency). When doing non-stream REST,
    // this can be passed; some voices ignore it. Safe to include.
    const latency = Number.isFinite(+input.latency) ? +input.latency : 2;

    // Voice settings
    const stability = Number.isFinite(+input.stability) ? +input.stability : 0.5;
    const similarity = Number.isFinite(+input.similarity) ? +input.similarity : 0.75;
    const style = Number.isFinite(+input.style) ? +input.style : 0.0;

    // Output format (see ElevenLabs docs for allowed values)
    // Common: mp3_44100_128, mp3_44100_192, mp3_44100_64, etc.
    const outputFormat = (input.outputFormat || "mp3_44100_128").toString();

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}`;

    const payload = {
      text,
      model_id: modelId,
      optimize_streaming_latency: latency, // accepted by some models/voices; harmless otherwise
      voice_settings: {
        stability,
        similarity_boost: similarity,
        style,
      },
      output_format: outputFormat,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      // Try to bubble up a helpful error
      let details = "";
      try { details = await res.text(); } catch (_) {}
      return makeErr(res.status, details || `ElevenLabs TTS error (${res.status})`);
    }

    const arrayBuf = await res.arrayBuffer();
    return makeBinary(Buffer.from(arrayBuf));
  } catch (e) {
    return makeErr(500, `tts exception: ${e.message || String(e)}`);
  }
};
