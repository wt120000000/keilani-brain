// netlify/functions/tts-stream.js
// POST { text, voiceId?, latency? } -> streaming audio/mpeg
// Uses ElevenLabs "optimize_streaming_latency" to start playback ASAP.

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

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { "Access-Control-Allow-Origin": "*" }, body: "Method Not Allowed" };
  }

  if (!process.env.ELEVEN_API_KEY) {
    return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: "Missing ELEVEN_API_KEY" };
  }

  try {
    const input = JSON.parse(event.body || "{}");
    const text = (input.text || "").toString().trim();
    const voiceId = (input.voiceId || process.env.ELEVEN_VOICE_ID || "").trim();
    const latency = Number.isFinite(input.latency) ? input.latency : 2; // 0..4 lower = faster
    const model_id = "eleven_monolingual_v1";

    if (!text)  return { statusCode: 400, headers: { "Access-Control-Allow-Origin": "*" }, body: "Missing text" };
    if (!voiceId) return { statusCode: 400, headers: { "Access-Control-Allow-Origin": "*" }, body: "Missing voiceId" };

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream` +
                `?optimize_streaming_latency=${latency}&output_format=mp3_44100_128`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text();
      return { statusCode: upstream.status, headers: { "Access-Control-Allow-Origin": "*" }, body: txt };
    }

    // Stream the ElevenLabs audio back to the client
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: `tts-stream exception: ${e.message}` };
  }
};
