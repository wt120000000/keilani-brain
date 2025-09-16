// netlify/functions/tts-stream.js
// Streams ElevenLabs audio back to the browser with chunked transfer.
// Body: { text: string, voice: string, model_id?: string, latency?: 0..4, format?: string }
// Defaults: model_id=eleven_multilingual_v2, latency=3, format=mp3_44100_128

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function j(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithBackoff(url, opts, { retries = 2, baseDelay = 500, maxDelay = 2500 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      const resp = await fetch(url, opts);
      if (!resp.ok && (resp.status === 429 || resp.status >= 500) && attempt < retries) {
        const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) + Math.random() * 150;
        attempt++; await sleep(delay); continue;
      }
      return resp;
    } catch (e) {
      if (attempt >= retries) throw e;
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt)) + Math.random() * 150;
      attempt++; await sleep(delay);
    }
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST")   return j(405, { error: "method_not_allowed" });

  const XI_KEY = process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY;
  if (!XI_KEY) return j(500, { error: "missing_env", detail: "Missing ELEVEN_API_KEY" });

  let body = {};
  try { body = await req.json(); } catch { return j(400, { error: "bad_json" }); }

  const text = (body.text || "").toString();
  const voice = (body.voice || "").toString();
  if (!text)  return j(400, { error: "missing_text" });
  if (!voice) return j(400, { error: "missing_voice" });

  const modelId = (body.model_id || process.env.ELEVEN_MODEL_ID || "eleven_multilingual_v2");
  const latency = Number.isFinite(body.latency) ? body.latency : (Number(process.env.ELEVEN_LATENCY || 3));
  const format  = (body.format || process.env.ELEVEN_FORMAT || "mp3_44100_128");

  // ElevenLabs streaming endpoint
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream`);
  url.searchParams.set("optimize_streaming_latency", String(latency)); // 0..4
  url.searchParams.set("output_format", format); // e.g. mp3_44100_128

  const upstream = await fetchWithBackoff(url, {
    method: "POST",
    headers: {
      "Accept": "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": XI_KEY,
    },
    // NOTE: we keep the body small / static. You can pass voice_settings if desired.
    body: JSON.stringify({
      text,
      model_id: modelId,
      // voice_settings: { stability: 0.6, similarity_boost: 0.8 }
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    return j(upstream.status || 502, { error: "eleven_error", raw: raw?.slice(0, 2000) });
  }

  // Pipe bytes through to client
  const headers = {
    ...CORS,
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-cache, no-transform",
    // Allow the <audio> element to begin playback as bytes come in.
    "Transfer-Encoding": "chunked"
  };

  return new Response(upstream.body, { status: 200, headers });
};
