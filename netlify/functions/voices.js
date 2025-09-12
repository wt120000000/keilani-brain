// netlify/functions/voices.js
// GET -> { voices: [{voice_id, name}] }

const ok = (obj) => ({
  statusCode: 200,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(obj),
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
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "GET") return err(405, "Method Not Allowed");
  if (!process.env.ELEVEN_API_KEY) return err(500, "Missing ELEVEN_API_KEY");

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": process.env.ELEVEN_API_KEY },
    });
    if (!res.ok) return err(res.status, await res.text());

    const data = await res.json();
    const voices = (data.voices || []).map(v => ({
      voice_id: v.voice_id,
      name: v.name,
    }));
    return ok({ voices });
  } catch (e) {
    return err(500, `voices exception: ${e.message}`);
  }
};
