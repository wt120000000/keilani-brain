// netlify/functions/did-speak.js
// CJS for Netlify, no external deps, uses native fetch (Node 18+)

// Env you need in Netlify:
//  - DID_API_KEY             (required)
//  - DID_VOICE_ID            (recommended for voice mode)
//  - DID_AVATAR_SOURCE_URL   (recommended for avatar mode)

const DID_API = "https://api.d-id.com";
const headersJson = (apiKey) => ({
  "Authorization": `Basic ${apiKey}`, // D-ID expects Basic <apiKey>
  "Content-Type": "application/json"
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Poll a D-ID "talk" until it's done (avatar mode)
async function pollTalk(apiKey, id, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${DID_API}/talks/${id}`, { headers: headersJson(apiKey) });
    if (!res.ok) throw new Error(`poll talks failed: ${res.status}`);
    const data = await res.json();
    if (data.status === "done" && data.result_url) return data.result_url;
    if (data.status === "error") throw new Error(data.error || "D-ID talk error");
    await sleep(1200);
  }
  throw new Error("D-ID talk timeout");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const API_KEY = process.env.DID_API_KEY;
    if (!API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing DID_API_KEY" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const text = (body.text || "").toString().trim();
    const mode = (body.mode || "voice"); // 'voice' | 'avatar'
    const voiceId = (body.voiceId || process.env.DID_VOICE_ID || "").trim();
    const avatarSource = (body.avatarSource || process.env.DID_AVATAR_SOURCE_URL || "").trim();

    if (!text) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing text" }) };
    }

    if (mode === "voice") {
      // --- VOICE (AUDIO ONLY) using D-ID TTS ---
      if (!voiceId) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing DID_VOICE_ID" }) };
      }

      const res = await fetch(`${DID_API}/tts`, {
        method: "POST",
        headers: headersJson(API_KEY),
        body: JSON.stringify({
          text,
          voice_id: voiceId,
          // Optional knobs you can tweak later:
          // voice_config: { style: 'General', speed: 1.0 }
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { statusCode: res.status, body: JSON.stringify({ error: data?.error || "D-ID TTS failed", debug: data }) };
      }
      if (!data.audio_url) {
        return { statusCode: 502, body: JSON.stringify({ error: "No audio_url from D-ID", debug: data }) };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ kind: "audio", url: data.audio_url })
      };
    }

    // --- AVATAR (VIDEO) using D-ID talks ---
    // You must supply a source image/video url that exists in D-ID (or a public URL they can pull).
    const source_url = avatarSource || "https://d-id-public-bucket.s3.amazonaws.com/or-roman.jpg"; // placeholder/demo image
    const create = await fetch(`${DID_API}/talks`, {
      method: "POST",
      headers: headersJson(API_KEY),
      body: JSON.stringify({
        source_url,
        script: {
          type: "text",
          input: text,
          provider: {
            type: "elevenlabs",
            // If your D-ID voice is linked to ElevenLabs, voice_id normally works here.
            voice_id: voiceId || undefined
          }
        }
      })
    });

    const created = await create.json().catch(() => ({}));
    if (!create.ok) {
      return { statusCode: create.status, body: JSON.stringify({ error: created?.error || "D-ID talk create failed", debug: created }) };
    }
    if (!created.id) {
      return { statusCode: 502, body: JSON.stringify({ error: "Missing talk id from D-ID", debug: created }) };
    }

    // Poll until ready
    const videoUrl = await pollTalk(API_KEY, created.id);
    return {
      statusCode: 200,
      body: JSON.stringify({ kind: "video", url: videoUrl })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
