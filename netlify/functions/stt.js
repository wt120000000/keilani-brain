// netlify/functions/stt.js
// CommonJS Netlify v1 handler. Accepts:
// 1) multipart/form-data with field "file" (Blob/WebM/Opus/WAV/MP3)
// 2) JSON { audioBase64, mime, filename }
// Sends to OpenAI transcription via fetch. No Busboy/OpenAI SDK.

const BOUNDARY_RE = /boundary=([^;]+)/i;

function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
const ok = (o) => json(200, o);

function bufFromBase64(b64) {
  try { return Buffer.from(b64, "base64"); } catch { return null; }
}

async function parseMultipart(event) {
  // Netlify hands raw body (string or base64). V1 functions typically give body as string.
  // We’ll try to leverage Request/Response Web API by rebuilding the request.
  try {
    const ctype = event.headers["content-type"] || event.headers["Content-Type"] || "";
    const boundary = (ctype.match(BOUNDARY_RE) || [])[1];
    if (!boundary) return null;
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body || "", "utf8");

    // Build a Request for FormData parsing using the runtime fetch impl:
    const req = new Request("http://local/upload", {
      method: "POST",
      headers: { "Content-Type": ctype },
      body: raw,
    });
    const form = await req.formData();
    const file = form.get("file");
    if (!file) return null;

    const arrayBuf = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const filename = file.name || "audio.webm";
    const mime = file.type || "application/octet-stream";
    return { buffer, filename, mime };
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    let audioBuffer = null;
    let filename = "audio.webm";
    let mime = "audio/webm";

    const ctype = event.headers["content-type"] || event.headers["Content-Type"] || "";

    if (ctype.startsWith("multipart/form-data")) {
      const parsed = await parseMultipart(event);
      if (parsed) {
        audioBuffer = parsed.buffer;
        filename = parsed.filename;
        mime = parsed.mime;
      }
    } else {
      // JSON body path: { audioBase64, mime, filename }
      try {
        const b = JSON.parse(event.body || "{}");
        if (b.audioBase64) {
          audioBuffer = bufFromBase64(b.audioBase64);
          if (b.filename) filename = String(b.filename);
          if (b.mime) mime = String(b.mime);
        }
      } catch {}
    }

    if (!audioBuffer || !audioBuffer.length) {
      return json(400, { error: "no_audio", detail: "Provide multipart 'file' or JSON {audioBase64,mime,filename}" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
    const STT_MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";
    if (!OPENAI_API_KEY) {
      return json(500, { error: "missing_openai_key" });
    }

    // Build multipart for OpenAI transcription endpoint
    const form = new FormData();
    form.append("model", STT_MODEL);
    form.append("file", new Blob([audioBuffer], { type: mime }), filename);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json(400, { error: "openai_stt_error", detail, meta: { bytes: audioBuffer.length, mime, model: STT_MODEL, status: res.status } });
    }

    const data = await res.json().catch(() => ({}));
    const transcript = data.text || data.transcript || "";

    return ok({ transcript, meta: { bytes: audioBuffer.length, mime, model: STT_MODEL, status: 200 } });
  } catch (err) {
    return json(400, { error: "stt_unhandled", detail: String(err) });
  }
};
