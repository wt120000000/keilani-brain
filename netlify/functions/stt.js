// netlify/functions/stt.js
// Accepts JSON: { audioBase64, mime, filename } and forwards to OpenAI Whisper
// No external deps -> fixes Netlify bundling errors.

const OA_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL  = "whisper-1"; // or "gpt-4o-mini-transcribe" if you prefer

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = need("OPENAI_API_KEY");
    const headers = {
      "Authorization": `Bearer ${apiKey}`
    };

    // Expect JSON body with base64
    const isJson = /application\/json/i.test(event.headers?.["content-type"] || "");
    if (!isJson) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "invalid_content_type",
          detail: "Send JSON: { audioBase64, mime, filename }"
        })
      };
    }

    const { audioBase64, mime = "audio/webm", filename = "speech.webm" } =
      JSON.parse(event.body || "{}");

    if (!audioBase64) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "missing_audio", detail: "audioBase64 is required" })
      };
    }

    // Build a multipart body locally
    const bin = Buffer.from(audioBase64, "base64");
    const blob = new Blob([bin], { type: mime });
    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("model", MODEL);

    const res = await fetch(OA_URL, { method: "POST", headers, body: fd });
    const js  = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: "openai_error", detail: js })
      };
    }

    // Whisper returns { text: "..." }
    const transcript = js.text || "";
    return {
      statusCode: 200,
      body: JSON.stringify({
        transcript,
        meta: { bytes: bin.length, mime, model: MODEL, via: "json_base64" }
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "stt_error", detail: String(err?.message || err) })
    };
  }
};
