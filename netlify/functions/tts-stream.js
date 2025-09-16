// netlify/functions/tts-stream.js
// POST { text, voice?, latency?:3, format?:'mp3_44100_128' } -> audio/mpeg (base64 body)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

const j = (status, body) => ({
  statusCode: status,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return j(405, { error: "method_not_allowed" });

    const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY;
    // NEW: allow a default voice on the server
    const DEFAULT_VOICE  = process.env.ELEVEN_DEFAULT_VOICE || process.env.ELEVEN_VOICE_ID_DEFAULT || "";

    if (!ELEVEN_API_KEY) return j(500, { error: "missing_eleven_api_key" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return j(400, { error: "invalid_json" }); }

    const text    = (body.text || "").trim();
    let   voiceId = (body.voice || "").trim();
    const latency = Number.isFinite(+body.latency) ? +body.latency : 3;        // 0..4
    const format  = (body.format || "mp3_44100_128").trim();

    if (!text) return j(400, { error: "missing_text" });

    // If client omitted voice, use server default (if any).
    if (!voiceId) {
      if (!DEFAULT_VOICE) return j(400, { error: "missing_voice", hint: "Provide body.voice or set ELEVEN_DEFAULT_VOICE" });
      voiceId = DEFAULT_VOICE;
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=${latency}&output_format=${encodeURIComponent(format)}`;

    console.log("[TTS-STREAM] → ElevenLabs", { voiceId, latency, format, len: text.length });

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({ text }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.warn("[TTS-STREAM] eleven error", upstream.status, errText?.slice(0, 300));
      return j(upstream.status, { error: "eleven_error", detail: errText || `HTTP ${upstream.status}` });
    }

    // Netlify Functions often buffer responses. Return a base64 body the browser will treat as binary.
    const ab = await upstream.arrayBuffer();
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
      body: Buffer.from(ab).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error("[TTS-STREAM] exception", e);
    return j(500, { error: "tts_stream_exception", detail: String(e?.message || e) });
  }
};
