// netlify/functions/tts-health.js
// GET -> masked view of what the function can see at runtime (safe to keep)
// This never logs/returns the key itself, only lengths.

exports.handler = async () => {
  const a = process.env.ELEVEN_API_KEY || "";
  const b = process.env.ELEVENLABS_API_KEY || "";
  const v = process.env.ELEVEN_VOICE_ID || "";

  const mask = (s) => (s ? `len:${s.length}` : "missing");
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      ELEVEN_API_KEY: mask(a),
      ELEVENLABS_API_KEY: mask(b),
      ELEVEN_VOICE_ID: v ? `set (${v.slice(0,4)}… )` : "missing",
      note: "Keys are masked; this only shows presence/length.",
    }),
  };
};
