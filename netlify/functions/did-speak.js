// netlify/functions/did-speak.js
// CJS + uses global fetch (Node 18+). No node-fetch needed.

const API = "https://api.d-id.com";

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: cors(),
      body: "",
    };
  }

  try {
    const DID_API_KEY = process.env.DID_API_KEY;
    const DID_AVATAR_SOURCE_URL = process.env.DID_AVATAR_SOURCE_URL; // public avatar image/video URL
    const DID_VOICE_ID = process.env.DID_VOICE_ID;                   // ElevenLabs voice_id configured inside D-ID

    if (!DID_API_KEY || !DID_AVATAR_SOURCE_URL || !DID_VOICE_ID) {
      return json(400, { error: "Missing env: DID_API_KEY, DID_AVATAR_SOURCE_URL, DID_VOICE_ID" });
    }

    if (event.httpMethod === "GET") {
      // Poll talk status: /.netlify/functions/did-speak?id=xxxx
      const id = (event.queryStringParameters && event.queryStringParameters.id) || "";
      if (!id) return json(400, { error: "Missing id" });

      const r = await fetch(`${API}/talks/${encodeURIComponent(id)}`, {
        headers: {
          Authorization: `Bearer ${DID_API_KEY}`,
          "Content-Type": "application/json",
        },
      });

      if (!r.ok) return json(r.status, { error: await safeText(r) });

      const data = await r.json();
      return json(200, {
        status: data.status,
        url: data.result_url || null,
        error: data.error || null,
      });
    }

    if (event.httpMethod === "POST") {
      // Create a talk
      const body = safeJSON(event.body);
      const text = (body && body.text) || "";
      if (!text.trim()) return json(400, { error: "Missing text" });

      const payload = {
        script: {
          type: "text",
          input: text,
          provider: { type: "elevenlabs", voice_id: DID_VOICE_ID },
        },
        source_url: DID_AVATAR_SOURCE_URL,
        config: {
          fluent: true,
          pad_audio: 0,
          stitch: true,
        },
      };

      const r = await fetch(`${API}/talks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!r.ok) return json(r.status, { error: await safeText(r) });

      const data = await r.json();
      return json(200, { id: data.id || null });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...cors() },
    body: JSON.stringify(obj),
  };
}

function safeJSON(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
async function safeText(r) {
  try { return await r.text(); } catch { return "unknown error"; }
}
