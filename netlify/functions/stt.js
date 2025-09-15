// netlify/functions/stt.js
// POST { audioBase64: "<raw base64 or data: URL>", language?: "en", verbose?: true } -> { transcript, ... }

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
const log = (...a) => { try { console.log(...a); } catch {} };

function sniffMagic(buf) {
  if (!buf || buf.length < 12) return "short";
  const a = buf.slice(0, 12).toString("ascii");
  if (a.startsWith("RIFF")) return "WAV/RIFF";
  if (a.startsWith("OggS")) return "OGG";
  if (a.startsWith("ID3")) return "MP3/ID3";
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return "MP3/Frame";
  // EBML header 0x1A45DFA3 → Matroska/WebM
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return "WEBM/MKV";
  return "unknown";
}
function normalizeContentType(ct) {
  if (!ct) return "application/octet-stream";
  const base = ct.split(";")[0].trim().toLowerCase();
  if (base.includes("wave") || base.includes("x-wav")) return "audio/wav";
  if (base === "audio/wav") return "audio/wav";
  if (base === "audio/mpeg" || base === "audio/mp3") return "audio/mpeg";
  if (base.startsWith("audio/webm")) return "audio/webm";
  if (base === "audio/ogg" || base === "application/ogg") return "audio/ogg";
  if (base === "audio/ogg;codecs=opus") return "audio/ogg"; // strip codecs
  return base || "application/octet-stream";
}
function pickFilename(ct, magic) {
  if (magic === "OGG") return "audio.ogg";
  if (magic === "WEBM/MKV") return "audio.webm";
  if (magic.startsWith("MP3")) return "audio.mp3";
  if (magic === "WAV/RIFF") return "audio.wav";
  if (ct.includes("wav")) return "audio.wav";
  if (ct.includes("mpeg")) return "audio.mp3";
  if (ct.includes("ogg")) return "audio.ogg";
  if (ct.includes("webm")) return "audio.webm";
  return "audio.bin";
}

async function callOpenAI(form, key, signal) {
  // Do not set Content-Type here — fetch sets the multipart boundary
  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  });
  const text = await resp.text();
  return { resp, text };
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

  let audioBase64 = "", mimeHint = "application/octet-stream", language, verbose = false;

  // Parse input
  try {
    const body = JSON.parse(event.body || "{}");
    const raw = (body.audioBase64 || "").trim();
    language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : undefined;
    verbose = Boolean(body.verbose);

    if (!raw) return json(400, { error: "missing_audio", detail: "Provide audioBase64 (raw base64 or data: URL)." });

    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      if (comma === -1) return json(400, { error: "bad_data_url", detail: "Malformed data: URL" });
      const header = raw.substring(0, comma); // e.g. data:audio/webm;codecs=opus;base64
      audioBase64 = raw.substring(comma + 1);
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
    const bytes = buf.length;
    const magic = sniffMagic(buf);
    let contentType = normalizeContentType(mimeHint);
    let fileName = pickFilename(contentType, magic);

    if (bytes < 200) {
      log("[STT] too small / invalid base64", { contentType, magic, bytes });
      return json(400, { error: "audio_too_small", detail: "Audio too small or invalid base64" });
    }
    if (bytes > 25 * 1024 * 1024) {
      log("[STT] too large", { bytes });
      return json(413, { error: "audio_too_large", detail: "Audio exceeds 25MB" });
    }

    log("[STT] inbound", { contentType, magic, fileName, bytes });

    // Build multipart using native FormData + File (Node 18+ via undici)
    const file1 = new File([buf], fileName, { type: contentType });
    const form1 = new FormData();
    form1.append("file", file1);
    form1.append("model", MODEL);
    form1.append("response_format", verbose ? "verbose_json" : "json");
    if (language) form1.append("language", language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    // Attempt #1: as declared
    let { resp, text } = await callOpenAI(form1, OPENAI_API_KEY, controller.signal);
    log("[STT] openai#1", { status: resp.status, len: text?.length || 0, ct: resp.headers.get("content-type") });

    // If OpenAI rejects the file as unsupported/corrupted, try a compatibility retry
    if (!resp.ok && text) {
      let detailObj;
      try { detailObj = JSON.parse(text); } catch {}
      const msg = (detailObj?.error?.message || "").toLowerCase();
      const code = (detailObj?.error?.code || "").toLowerCase();
      const isInvalidFile = msg.includes("unsupported") || msg.includes("corrupted") || code.includes("invalid_value");

      if (isInvalidFile) {
        // Retry with a filename that matches the sniffed magic, and a generic content type
        const forcedName =
          magic === "OGG" ? "audio.ogg" :
          magic === "WEBM/MKV" ? "audio.webm" :
          magic.startsWith("MP3") ? "audio.mp3" :
          magic === "WAV/RIFF" ? "audio.wav" :
          "audio.bin";
        const file2 = new File([buf], forcedName, { type: "application/octet-stream" });
        const form2 = new FormData();
        form2.append("file", file2);
        form2.append("model", MODEL);
        form2.append("response_format", verbose ? "verbose_json" : "json");
        if (language) form2.append("language", language);

        ({ resp, text } = await callOpenAI(form2, OPENAI_API_KEY, controller.signal));
        log("[STT] openai#2 (retry)", { status: resp.status, len: text?.length || 0, ct: resp.headers.get("content-type"), forcedName });
      }
    }

    clearTimeout(timeout);

    if (!resp.ok) {
      let detail = text;
      try { detail = JSON.parse(text); } catch {}
      return json(resp.status, { error: "openai_stt_error", detail });
    }

    let data = {};
    try { data = JSON.parse(text); } catch {}
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
    const msg = e?.name === "AbortError" ? "openai_timeout" : (e?.message || String(e));
    log("[STT] exception", msg);
    return json(500, { error: "stt_exception", detail: msg });
  }
};
