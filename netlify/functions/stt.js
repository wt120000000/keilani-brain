// netlify/functions/stt.js
// POST { audioBase64: "<raw b64 | data URL>", language?: "en" } -> { transcript }
// - Ignores tiny audio
// - Normalizes mime/filename for OpenAI
// - Retries 3x with backoff on 429/5xx

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
const json = (status, body) => ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    if (event.httpMethod !== "POST")  return json(405, { error: "method_not_allowed" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";
    if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "invalid_json" }); }

    let audioBase64 = (body.audioBase64 || "").trim();
    const language = (body.language || "").trim() || undefined;
    if (!audioBase64) return json(400, { error: "missing_audio" });

    // Parse data URL or raw b64
    let mime = "audio/webm";
    if (audioBase64.startsWith("data:")) {
      const comma = audioBase64.indexOf(",");
      const header = audioBase64.slice(0, comma);
      const b64 = audioBase64.slice(comma + 1);
      audioBase64 = b64;
      const m = header.match(/^data:([^;]+)/);
      if (m && m[1]) mime = m[1];
    }

    // Normalize mime to a safe filename/contentType OpenAI likes
    const ext =
      mime.includes("wav") ? "wav" :
      mime.includes("mp3") ? "mp3" :
      mime.includes("m4a") ? "m4a" :
      mime.includes("ogg") ? "ogg" : "webm";

    // Some browsers give "audio/webm;codecs=opus" -> use generic type
    const normalizedMime =
      mime.startsWith("audio/webm") ? "audio/webm" :
      mime.startsWith("audio/ogg")  ? "audio/ogg"  : mime;

    const buf = Buffer.from(audioBase64, "base64");
    if (!buf || buf.length < 2000) {
      // Too small = usually no speech
      return json(200, { transcript: "" });
    }

    // Build form-data with native undici FormData/Blob (Node 18+)
    const form = new FormData();
    const blob = new Blob([buf], { type: normalizedMime });
    form.append("file", blob, `audio.${ext}`);
    form.append("model", MODEL);
    form.append("response_format", "json");
    if (language) form.append("language", language);

    // Retry helper
    const backoff = (n) => new Promise((r) => setTimeout(r, 300 * Math.pow(2, n)));
    let resp, text, ok = false, lastErr = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: form,
        });
        text = await resp.text();
        if (resp.ok) { ok = true; break; }

        // Retry on 429/5xx
        if (resp.status === 429 || (resp.status >= 500 && resp.status <= 599)) {
          await backoff(attempt);
          continue;
        }
        // Non-retryable
        lastErr = text;
        break;
      } catch (e) {
        lastErr = String(e?.message || e);
        await backoff(attempt);
      }
    }

    if (!ok) return json(resp?.status || 500, { error: "openai_stt_error", detail: tryParse(lastErr) });

    let data = {};
    try { data = JSON.parse(text); } catch { data = { text: "" }; }
    return json(200, { transcript: data.text || "" });
  } catch (e) {
    return json(500, { error: "stt_exception", detail: String(e?.message || e) });
  }
};

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
