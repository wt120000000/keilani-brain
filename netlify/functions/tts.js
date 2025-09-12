// netlify/functions/tts.js (CommonJS)
// POST { text, voiceId? } -> audio/mpeg (base64)

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
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  if (!process.env.ELEVEN_API_KEY) return { statusCode: 500, body: "Missing ELEVEN_API_KEY" };

  try {
    const { text, voiceId } = JSON.parse(event.body || "{}");
    if (!text) return { statusCode: 400, body: "Missing text" };

    const vid = voiceId || process.env.ELEVEN_VOICE_ID;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream?optimize_streaming_latency=1`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.45, similarity_boost: 0.8 },
      }),
    });

    if (!res.ok) return { statusCode: res.status, body: await res.text() };

    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: `tts error: ${err.message}` };
  }
};
