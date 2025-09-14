// netlify/functions/stt.js
// POST { audioBase64: "<base64 or data: URL>", language?: "en", verbose?: true } -> { transcript, ... }
const fetch = require("node-fetch");
const FormData = require("form-data");

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed", detail: "Use POST with JSON body." });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_STT_MODEL || "whisper-1";
  if (!OPENAI_API_KEY) return json(500, { error: "missing_env", detail: "Missing OPENAI_API_KEY" });

  let audioBase64 = "";
  let mimeHint = "audio/webm";
  let language = undefined;
  let verbose = false;

  // Parse body
  try {
    const body = JSON.parse(event.body || "{}");
    const raw = (body.audioBase64 || "").trim();
    language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : undefined;
    verbose = Boolean(body.verbose);

    if (!raw) return json(400, { error: "missing_audio", detail: "Provide audioBase64 (raw base64 or data: URL)." });

    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      if (comma === -1) return json(400, { error: "bad_data_url", detail: "Malformed data: URL" });
      const header = raw.substring(0, comma);
      const b64 = raw.substring(comma + 1);
      audioBase64 = b64;
      const m = header.match(/^data:([^;]+)/);
      if (m) mimeHint = m[1];
    } else {
      audioBase64 = raw;
    }
  } catch {
    return json(400, { error: "bad_json", detail: "Invalid JSON body" });
  }

  try {
    const buf = Buffer.from(audioBase64, "base64");
    if (!buf || buf.length < 200) {
      return json(400, { error: "audio_too_small", detail: "Audio too small or invalid base64" });
    }
    const MAX_BYTES = 25 * 1024 * 1024;
    if (buf.length > MAX_BYTES) {
      return json(413, { error: "audio_too_large", detail: `Audio exceeds ${MAX_BYTES} bytes` });
    }

    const fileName =
      mimeHint.includes("wav") ? "audio.wav" :
      mimeHint.includes("mp3") ? "audio.mp3" :
      mimeHint.includes("m4a") ? "audio.m4a" :
      mimeHint.includes("ogg") ? "audio.ogg" :
      "audio.webm";

    const form = new FormData();
    form.append("file", buf, { filename: fileName, contentType: mimeHint });
    form.append("model", MODEL);
    form.append("response_format", verbose ? "verbose_json" : "json");
    if (language) form.append("language", language);

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const text = await resp.text();
    if (!resp.ok) {
      return json(resp.status, { error: "openai_stt_error", detail: text });
    }

    let data;
    try { data = JSON.parse(text); } catch { data = {}; }

    if (verbose) {
      return json(200, {
        transcript: data.text || "",
        verbose: true,
        language: data.language,
        duration: data.duration,
        segments: data.segments || [],
        raw: data,
      });
    }

    return json(200, { transcript: data.text || "" });
  } catch (e) {
    return json(500, { error: "stt_exception", detail: String(e && e.message ? e.message : e) });
  }
};
