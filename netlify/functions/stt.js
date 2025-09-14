// netlify/functions/stt.js
// POST { audioBase64: "<raw base64 or data: URL>", language?: "en", verbose?: true } -> { transcript, ...optionalVerbose }
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

// Simple console logger that won't crash Netlify if body isn't serializable
function log(...args) {
  try { console.log(...args); } catch (_) {}
}

exports.handler = async (event) => {
  // --- CORS preflight
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
  if (!OPENAI_API_KEY) {
    return json(500, { error: "missing_env", detail: "Missing OPENAI_API_KEY" });
  }

  let audioBase64 = "";
  let mimeHint = "audio/webm";
  let language;
  let verbose = false;

  // --- Parse request body
  try {
    const body = JSON.parse(event.body || "{}");
    const raw = (body.audioBase64 || "").trim();
    language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : undefined;
    verbose = Boolean(body.verbose);

    if (!raw) {
      return json(400, { error: "missing_audio", detail: "Provide audioBase64 (raw base64 or data: URL)." });
    }

    if (raw.startsWith("data:")) {
      // data:audio/ogg;codecs=opus;base64,AAAA...
      const comma = raw.indexOf(",");
      if (comma === -1) return json(400, { error: "bad_data_url", detail: "Malformed data: URL" });
      const header = raw.substring(0, comma);
      const b64 = raw.substring(comma + 1);
      audioBase64 = b64;

      const m = header.match(/^data:([^;]+)/); // strip anything after first ';' (e.g., ;codecs=opus)
      if (m) mimeHint = m[1];
    } else {
      audioBase64 = raw;
    }
  } catch {
    return json(400, { error: "bad_json", detail: "Invalid JSON body" });
  }

  // --- Build file + call OpenAI
  try {
    const buf = Buffer.from(audioBase64, "base64");
    const bytes = buf?.length || 0;

    // Normalize content-type (strip codecs; OpenAI sniffs content anyway)
    const normalizedContentType = (mimeHint || "audio/webm").split(";")[0];

    if (!bytes || bytes < 200) {
      log("[STT] too small / invalid base64:", { normalizedContentType, bytes });
      return json(400, { error: "audio_too_small", detail: "Audio too small or invalid base64" });
    }

    const MAX_BYTES = 25 * 1024 * 1024;
    if (bytes > MAX_BYTES) {
      log("[STT] too large:", { bytes });
      return json(413, { error: "audio_too_large", detail: `Audio exceeds ${MAX_BYTES} bytes` });
    }

    // Pick a filename extension as a hint to the server
    const fileName =
      normalizedContentType.includes("wav") ? "audio.wav" :
      normalizedContentType.includes("mp3") ? "audio.mp3" :
      normalizedContentType.includes("m4a") ? "audio.m4a" :
      normalizedContentType.includes("ogg") ? "audio.ogg" :
      "audio.webm";

    log("[STT] inbound file", { mimeHint, normalizedContentType, fileName, bytes });

    const form = new FormData();
    form.append("file", buf, { filename: fileName, contentType: normalizedContentType });
    form.append("model", MODEL);
    form.append("response_format", verbose ? "verbose_json" : "json");
    if (language) form.append("language", language);

    // Add a timeout guard so a stuck call doesn't hang the function
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let resp, text;
    try {
      resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
        signal: controller.signal,
      });
      text = await resp.text();
    } finally {
      clearTimeout(timeout);
    }

    log("[STT] openai response", {
      status: resp.status,
      contentType: resp.headers.get("content-type"),
      length: text?.length ?? 0,
    });

    if (!resp.ok) {
      // Try to surface OpenAI's error JSON if present
      let detail = text;
      try {
        const errObj = JSON.parse(text);
        detail = errObj;
      } catch {}
      return json(resp.status, { error: "openai_stt_error", detail });
    }

    let data = {};
    try { data = JSON.parse(text); } catch {}

    // Helpful debug logs (visible in Netlify function logs)
    log("[STT] parsed", {
      hasText: Boolean((data.text || "").trim()),
      textLen: (data.text || "").length,
      language: data.language,
      duration: data.duration,
      segments: Array.isArray(data.segments) ? data.segments.length : 0,
    });

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

    return json(200, { transcript: (data.text || "").trim() });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "openai_timeout" : (e.message || String(e));
    log("[STT] exception", msg);
    return json(500, { error: "stt_exception", detail: msg });
  }
};
