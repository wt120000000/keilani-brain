// netlify/functions/tts.js
// POST { text, voiceId? } -> audio/mpeg (binary)

const buf = (body, extra = {}) => ({
  statusCode: 200,
  isBase64Encoded: true,
  headers: {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  },
  body: body.toString("base64"),
});

const err = (status, msg) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify({ error: msg }),
});

exports.handler = async (event) => {
  // CORS preflight
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

  if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");
  if (!process.env.ELEVEN_API_KEY) return err(500, "Missing ELEVEN_API_KEY");

  try {
    const input = JSON.parse(event.body || "{}");
    const text = (input.text || "").toString().trim();
    const voiceId = (input.voiceId || process.env.ELEVEN_VOICE_ID || "").trim();

    if (!text) return err(400, "Missing text");
    if (!voiceId) return err(400, "Missing voiceId (and ELEVEN_VOICE_ID fallback not set)");

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

    // You can tweak model or voice settings if you like
    const payload = {
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      return err(res.status, text);
    }

    const arrayBuf = await res.arrayBuffer();
    return buf(Buffer.from(arrayBuf));
  } catch (e) {
    return err(500, `tts exception: ${e.message}`);
  }
};
