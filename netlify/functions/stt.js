// netlify/functions/stt.js
// POST { audioBase64: "data:audio/webm;base64,..." | "<base64>" , language? } -> { transcript }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
const j = (status, body) => ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return j(405, { error: "method_not_allowed" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";
    if (!OPENAI_API_KEY) return j(500, { error: "missing_api_key" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return j(400, { error: "invalid_json" }); }

    // Accept raw base64 or data URL
    const raw = (body.audioBase64 || "").trim();
    if (!raw) return j(400, { error: "missing_audio" });

    let mimeHint = "audio/webm";
    let b64 = raw;

    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      const header = raw.substring(0, comma);
      b64 = raw.substring(comma + 1);

      // normalize to base mime (audio/webm;codecs=opus -> audio/webm)
      const m = header.match(/^data:([^;]+)/i);
      if (m) {
        const base = (m[1] || "").toLowerCase();
        mimeHint = base.split(";")[0] || base || "audio/webm";
      }
    }

    const buf = Buffer.from(b64, "base64");
    if (!buf || buf.length < 200) return j(400, { error: "audio_too_small" });

    // Pick a filename that matches the BASE type only
    const base = (mimeHint || "").toLowerCase();
    const fileName =
      base.includes("wav") ? "audio.wav" :
      base.includes("mp3") ? "audio.mp3" :
      base.includes("m4a") ? "audio.m4a" :
      base.includes("ogg") ? "audio.ogg" :
      "audio.webm";

    // Build multipart form *without* codecs in contentType
    const form = new FormData();
    form.append("file", new Blob([buf], { type: base || "application/octet-stream" }), fileName);
    form.append("model", MODEL);
    form.append("response_format", "json");
    if (body.language) form.append("language", String(body.language));

    // Log a tiny breadcrumb (shows up in netlify logs)
    console.log("[STT] inbound", { fileName, bytes: buf.length, model: MODEL, contentType: base });

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.warn("[STT] openai error", resp.status, text?.slice(0, 300));
      return j(resp.status, { error: "openai_stt_error", detail: text ? JSON.parse(text).error ?? text : "unknown" });
    }

    let data = {};
    try { data = JSON.parse(text); } catch { data = { text: "" }; }

    const transcript = (data.text || "").trim();
    console.log("[STT] ok", { len: transcript.length });

    return j(200, { transcript });
  } catch (e) {
    console.error("[STT] exception", e);
    return j(500, { error: "stt_exception", detail: String(e?.message || e) });
  }
};
