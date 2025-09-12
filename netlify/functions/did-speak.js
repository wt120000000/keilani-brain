// netlify/functions/did-speak.js
// Server-side voice helper for Keilani Chat
//
// Modes supported:
// 1) Studio TTS (D-ID Studio secret key in env DID_API_KEY)  -> returns { ok:true, used:'studio', url, contentType:'audio/mp3' }
// 2) Agent (D-ID Agent key). Browser "client" keys are NOT allowed for server calls.
//    If only DID_AGENT_KEY is present (client key), we return 403 with a helpful message.
//    If you later obtain a real server key for Agents, see the AGENT section below.
//
// Env vars used (set in Netlify):
//   DID_API_KEY              - D-ID Studio secret key (starts with sk_...), server-to-server
//   DID_VOICE_ID   (optional) - Studio TTS voice id (e.g. 'en-US-JennyNeural' or a D-ID voice id)
//   DID_AGENT_KEY  (optional) - D-ID Agent key (browser client key is NOT valid for server calls)
//   DID_AGENT_ID   (optional) - Agent id if/when you enable the server-side agent branch
//
// HTTP:
//   POST /api/did-speak   body: { text:string, mode?: 'D-ID Voice' | 'D-ID Avatar' }
//   (We treat both modes the same for Studio TTS; avatar streaming requires a different Studio workflow.)
//   GET  /api/did-speak?id=<direct-media-url>  (simple proxy/HEAD checker is omitted for now)

const STUDIO_BASE = 'https://api.d-id.com'; // Studio API (server-to-server)
const STUDIO_TTS_ENDPOINT = `${STUDIO_BASE}/tts/speak`; // returns { url: "https://.../audio.mp3" }

const STUDIO_KEY = process.env.DID_API_KEY;          // secret, starts with sk_ (server ok)
const AGENT_KEY  = process.env.DID_AGENT_KEY || '';  // browser client key (NOT ok for server by default)
const AGENT_ID   = process.env.DID_AGENT_ID || '';   // if you enable agent server flow later
const DEFAULT_VOICE = process.env.DID_VOICE_ID || 'en-US-JennyNeural';

// flip to true only if you have an AGENT *server* key allowed for server-to-server use
const AGENT_SERVER_MODE = false;

function json(status, obj) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
      body: '',
    };
  }

  // Basic method guard
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const text = (body.text || '').toString().trim();
  const mode = (body.mode || 'D-ID Voice').toString();

  if (!text) {
    return json(400, { ok: false, error: 'Missing "text"' });
  }

  // --- Prefer Studio TTS if a Studio secret key is available  -----------------
  if (STUDIO_KEY) {
    try {
      // D-ID Studio TTS
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${STUDIO_KEY}`,
      };

      // The Studio endpoint accepts a variety of shapes depending on your account/voice.
      // Minimal shape that works broadly:
      const payload = {
        text,
        voice: DEFAULT_VOICE, // D-ID will resolve the voice if this is a valid voice id/name
        // You can add: 'output_format': 'mp3', 'sample_rate': 22050, etc.
      };

      const resp = await fetch(STUDIO_TTS_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return json(resp.status, {
          ok: false,
          used: 'studio',
          error: data?.message || 'D-ID Studio TTS error',
          raw: data,
        });
      }

      const url = data?.url;
      if (!url) {
        return json(502, {
          ok: false,
          used: 'studio',
          error: 'TTS returned no URL',
          raw: data,
        });
      }

      // Return a simple playable resource
      return json(200, {
        ok: true,
        used: 'studio',
        url,                // mp3 URL (S3)
        contentType: 'audio/mp3',
        mode,
      });
    } catch (err) {
      return json(500, { ok: false, used: 'studio', error: String(err) });
    }
  }

  // --- Agent branch (by default we block if you only have a CLIENT key) -------
  if (AGENT_KEY) {
    if (!AGENT_SERVER_MODE) {
      // You currently have a browser client key. Server-to-server is not allowed -> 403
      return json(403, {
        ok: false,
        used: 'agent',
        error:
          'D-ID Agent client keys cannot be used for server-side API calls. ' +
          'Add a Studio secret key in DID_API_KEY for TTS, or obtain an Agent server key and set AGENT_SERVER_MODE=true.',
      });
    }

    // If/when you obtain an Agent **server** key and want to enable server calls, wire it here:
    // (The exact agent speak endpoint/auth may differ depending on your D-ID plan;
    //  confirm with D-ID docs and replace the stub below.)

    try {
      if (!AGENT_ID) {
        return json(400, { ok: false, used: 'agent', error: 'Missing DID_AGENT_ID' });
      }

      // Example scaffold (replace with the real Agent server endpoint & auth header)
      const AGENT_BASE = 'https://agent.d-id.com';
      const AGENT_SPEAK = `${AGENT_BASE}/v1/agents/${AGENT_ID}/speak`;

      const resp = await fetch(AGENT_SPEAK, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // This header is only a placeholder; use whatever the server key auth actually requires:
          'Authorization': `Bearer ${AGENT_KEY}`,
        },
        body: JSON.stringify({ text }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return json(resp.status, {
          ok: false,
          used: 'agent',
          error: data?.message || 'D-ID Agent speak error',
          raw: data,
        });
      }

      // If agent returns a media url, pass it back; otherwise adapt to their response shape.
      const url = data?.url || data?.audio?.url || null;
      return json(200, {
        ok: true,
        used: 'agent',
        url,
        contentType: url ? 'audio/mp3' : undefined,
        raw: data,
      });
    } catch (err) {
      return json(500, { ok: false, used: 'agent', error: String(err) });
    }
  }

  // No credentials provided
  return json(501, {
    ok: false,
    error:
      'No D-ID credentials available. Set DID_API_KEY for Studio TTS, or DID_AGENT_KEY + server mode for Agent.',
  });
};
