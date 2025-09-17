// netlify/functions/stt.js
// POST { audioBase64: "<base64 or data:URI>", language?: "en" } -> { transcript }
//
// Notes:
// - Accepts data URLs or raw base64
// - Sniffs content type for a good filename hint (OpenAI sniffs anyway)
// - Rejects very small payloads before hitting OpenAI
// - Uses gpt-4o-mini-transcribe by default with response_format "json"
// - Bubbles up OpenAI error details for easy debugging

const fetch = require("node-fetch");
const FormData = require("form-data");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  };
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    // CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders(), body: "" };
    }
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";
    if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

    // Parse incoming JSON
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const raw = String(body.audioBase64 || "").trim();
    const language = body.language && String(body.language).trim();
    if (!raw) return json(400, { error: "missing_audio" });

    // Accept data:URI or raw base64
    let audioBase64 = raw;
    let mimeHint = "audio/webm";
    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      const header = raw.substring(0, comma);
      audioBase64 = raw.substring(comma + 1);
      const m = header.match(/^data:([^;]+)/);
      if (m) mimeHint = m[1];
    }

    const buf = Buffer.from(audioBase64, "base64");
    if (!buf || buf.length < 2000) {
      return json(400, { error: "audio_too_small", detail: { bytes: buf?.length || 0 } });
    }

    // Prepare multipart form
    const form = new FormData();
    const fileName =
      mimeHint.includes("wav")  ? "audio.wav"  :
      mimeHint.includes("mp3")  ? "audio.mp3"  :
      mimeHint.includes("m4a")  ? "audio.m4a"  :
      mimeHint.includes("ogg")  ? "audio.ogg"  :
      mimeHint.includes("webm") ? "audio.webm" : "audio.webm";

    form.append("file", buf, { filename: fileName, contentType: mimeHint });
    form.append("model", MODEL);
    // gpt-4o-mini-transcribe expects "json" or "text"
    form.append("response_format", "json");
    if (language) form.append("language", language);

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const text = await resp.text();
    if (!resp.ok) {
      // Include OpenAI error and our sniffed metadata
      return json(resp.status, {
        error: "openai_stt_error",
        detail: safeParse(text) || text,
        meta: { mimeHint, fileName, bytes: buf.length, model: MODEL },
      });
    }

    const data = safeParse(text) || { text: "" };
    return json(200, { transcript: data.text || "" });
  } catch (e) {
    return json(500, { error: "stt_exception", detail: String(e.message || e) });
  }
};

function safeParse(t) {
  try { return JSON.parse(t); } catch { return null; }
}
