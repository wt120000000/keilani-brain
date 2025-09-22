// netlify/functions/tts.js
// CommonJS Netlify v1 handler. ElevenLabs TTS without node-fetch import.

function json(status, obj, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(obj),
    isBase64Encoded: false,
  };
}

function audio(status, buffer, mime = "audio/mpeg") {
  return {
    statusCode: status,
    headers: {
      "Content-Type": mime,
      "Cache-Control": "no-store",
    },
    body: buffer.toString("base64"),
    isBase64Encoded: true,
  };
}

function clamp01(x, def = 0.5) {
  const n = typeof x === "string" ? parseFloat(x) : x;
  if (!isFinite(n)) return def;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    const body = JSON.parse(event.body || "{}");
    const text = String(body.text || "").trim();
    if (!text) return json(400, { error: "missing_text" });

    const ELEVEN_KEY = process.env.ELEVEN_API_KEY || "";
    const VOICE_ID = body.voice || process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel default
    if (!ELEVEN_KEY) return json(500, { error: "missing_eleven_key" });

    const stability = clamp01(body?.emotion?.stability, 0.55);
    const similarity = clamp01(body?.emotion?.similarity, 0.7);
    const style = clamp01(body?.emotion?.style, 0.4);
    const speed = body?.speed && isFinite(Number(body.speed)) ? Number(body.speed) : 1.0;

    const payload = {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability,
        similarity_boost: similarity,
        style,
        use_speaker_boost: true,
      },
      // Some SDKs call this "optimize_streaming_latency"; leaving defaults
    };

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?optimize_streaming_latency=0&output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
        "X-Voice-Speed": String(speed), // not official; kept here if you route via proxy later
      },
      body: JSON.stringify(payload),
    });

    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      let detail = "";
      try { detail = buf.toString("utf8"); } catch {}
      return json(400, { error: "tts_eleven_error", detail });
    }

    return audio(200, buf, "audio/mpeg");
  } catch (err) {
    return json(200, { error: "tts_unhandled", detail: String(err) });
  }
};
