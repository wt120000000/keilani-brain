// netlify/functions/stt.js
// POST { audioBase64: "<base64 of audio/webm|wav|mp3|m4a|ogg>" } -> { transcript }

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
    return json(405, { error: "Method Not Allowed" });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_STT_MODEL || "whisper-1";

  if (!OPENAI_API_KEY) return json(500, { error: "Missing OPENAI_API_KEY" });

  let audioBase64 = "";
  let mimeHint = "audio/webm"; // Whisper can auto-detect; this is just a filename hint.

  try {
    const body = JSON.parse(event.body || "{}");

    // Accept either raw base64 or a data URL
    const raw = (body.audioBase64 || "").trim();
    if (!raw) return json(400, { error: "Missing audioBase64" });

    if (raw.startsWith("data:")) {
      // data:audio/webm;base64,AAAA...
      const comma = raw.indexOf(",");
      const header = raw.substring(0, comma);
      const b64 = raw.substring(comma + 1);
      audioBase64 = b64;
      const m = header.match(/^data:([^;]+)/);
      if (m) mimeHint = m[1];
    } else {
      audioBase64 = raw;
    }
  } catch (e) {
    return json(400, { error: "Invalid JSON body" });
  }

  try {
    const buf = Buffer.from(audioBase64, "base64");
    if (!buf || buf.length < 200) {
      return json(400, { error: "Audio too small or invalid base64" });
    }

    const form = new FormData();
    // Filename extension is only used as a hint; Whisper will sniff the content.
    const fileName =
      mimeHint.includes("wav") ? "audio.wav"
      : mimeHint.includes("mp3") ? "audio.mp3"
      : mimeHint.includes("m4a") ? "audio.m4a"
      : mimeHint.includes("ogg") ? "audio.ogg"
      : "audio.webm";

    form.append("file", buf, { filename: fileName, contentType: mimeHint });
    form.append("model", MODEL);
    form.append("response_format", "json");
    // You can force language if you know it, e.g. form.append("language", "en");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const text = await resp.text();
    if (!resp.ok) {
      // Bubble up Whisper error details
      return json(resp.status, { error: "openai_stt_error", detail: text });
    }

    let data;
    try { data = JSON.parse(text); } catch { data = { text: "" }; }

    return json(200, { transcript: data.text || "" });
  } catch (e) {
    return json(500, { error: "stt_exception", detail: String(e.message || e) });
  }
};
