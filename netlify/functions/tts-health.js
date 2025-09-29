// netlify/functions/tts-health.js
// GET -> masked env + live probe to /v1/voices using the exact key used by tts.js

exports.handler = async () => {
  const rawA = process.env.ELEVEN_API_KEY || "";
  const rawB = process.env.ELEVENLABS_API_KEY || "";
  const key = (rawA || rawB || "").trim();
  const voiceId = (process.env.ELEVEN_VOICE_ID || "").trim();

  const mask = (s) => (s ? `len:${s.length}` : "missing");

  let probe = { status: "skipped" };
  if (key) {
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": key },
      });
      let detail = null;
      try { detail = await r.json(); } catch { detail = await r.text(); }
      probe = { status: r.status, ok: r.ok, detail };
    } catch (e) {
      probe = { status: "exception", detail: String(e?.message || e) };
    }
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      ELEVEN_API_KEY: mask(rawA),
      ELEVENLABS_API_KEY: mask(rawB),
      ELEVEN_VOICE_ID: voiceId ? `set (${voiceId.slice(0, 4)}… )` : "missing",
      probe,
      note: "Keys are masked; this only shows presence/length.",
    }),
  };
};
