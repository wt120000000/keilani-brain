// netlify/functions/stt.js
// POST { audioBase64: "<raw b64 or data: URL>", language?: "en" } -> { transcript }
// MIME sniffing, filename hints, retry/backoff, per-IP rate limiting (CJS).

const { allow } = require("./_ratelimit.cjs");

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
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return "WEBM/MKV";
  return "unknown";
}
function baseCT(ct) { return (ct || "").split(";")[0].trim().toLowerCase(); }
function normalizeFromHint(ct) {
  const b = baseCT(ct);
  if (b === "audio/webm") return "audio/webm";
  if (b === "audio/ogg" || b === "application/ogg") return "audio/ogg";
  if (b === "audio/wav" || b.includes("x-wav") || b.includes("wave")) return "audio/wav";
  if (b === "audio/mpeg" || b === "audio/mp3") return "audio/mpeg";
  return b || "";
}
function contentTypeFromMagic(magic) {
  if (magic === "WEBM/MKV") return "audio/webm";
  if (magic === "OGG") return "audio/ogg";
  if (magic === "WAV/RIFF") return "audio/wav";
  if (magic.startsWith("MP3")) return "audio/mpeg";
  return "";
}
function filenameForCT(ct) {
  if (ct.includes("webm")) return "audio.webm";
  if (ct.includes("ogg"))  return "audio.ogg";
  if (ct.includes("wav"))  return "audio.wav";
  if (ct.includes("mpeg")) return "audio.mp3";
  return "audio.bin";
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function callOpenAI(form, key, { retries = 2, baseDelay = 500, maxDelay = 2500 } = {}) {
  let attempt = 0;
  while (true) {
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!resp.ok && (resp.status === 429 || resp.status >= 500) && attempt < retries) {
      const delay = Math.min(maxDelay, baseDelay*Math.pow(2, attempt)) + Math.random()*150;
      attempt++; await sleep(delay); continue;
    }
    const text = await resp.text();
    return { resp, text };
  }
}

exports.handler = async (event) => {
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
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  // 9) rate limit
  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'anon';
  const cap = Number(process.env.RL_TOKENS || 30);
  const rps = Number(process.env.RL_REFILL_PER_SEC || 1.5);
  if (!allow(ip, { capacity: cap, refillPerSec: rps })) {
    return json(429, { error: "rate_limited" });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";
  if (!OPENAI_API_KEY) return json(500, { error: "missing_env", detail: "Missing OPENAI_API_KEY" });

  let audioBase64 = "", hint = "", language;
  try {
    const body = JSON.parse(event.body || "{}");
    const raw = (body.audioBase64 || "").trim();
    language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : undefined;
    if (!raw) return json(400, { error: "missing_audio" });

    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      if (comma < 0) return json(400, { error: "bad_data_url" });
      const header = raw.substring(0, comma);
      audioBase64 = raw.substring(comma + 1);
      const m = header.match(/^data:([^;]+)/);
      if (m) hint = m[1];
    } else {
      audioBase64 = raw;
    }
  } catch {
    return json(400, { error: "bad_json" });
  }

  try {
    const buf = Buffer.from(audioBase64, "base64");
    const bytes = buf.length;
    const magic = sniffMagic(buf);

    if (bytes < 200) return json(400, { error: "audio_too_small" });
    if (bytes > 25 * 1024 * 1024) return json(413, { error: "audio_too_large" });

    const ctFromMagic = contentTypeFromMagic(magic);
    const ctFromHint  = normalizeFromHint(hint);
    let contentType = ctFromHint || ctFromMagic || "audio/webm";
    let fileName    = filenameForCT(contentType);

    log("[STT] inbound", { hint: hint || null, magic, contentType, fileName, bytes, model: MODEL });

    const file = new File([buf], fileName, { type: contentType });
    const makeForm = () => {
      const form = new FormData();
      form.append("file", file);
      form.append("model", MODEL);
      form.append("response_format", "json");
      if (language) form.append("language", language);
      return form;
    };

    let { resp, text } = await callOpenAI(makeForm(), OPENAI_API_KEY);
    log("[STT] openai#1", { status: resp.status, len: text?.length || 0, ct: resp.headers.get("content-type") });

    if (!resp.ok && text) {
      let err; try { err = JSON.parse(text); } catch {}
      const msg  = (err?.error?.message || "").toLowerCase();
      const code = (err?.error?.code || "").toLowerCase();
      const unsupported = msg.includes("unsupported") || msg.includes("corrupted") || code.includes("invalid_value");
      if (unsupported) {
        const retryCT = ctFromMagic || ctFromHint || "audio/webm";
        const retryName = filenameForCT(retryCT);
        const retryFile = new File([buf], retryName, { type: retryCT });
        const form = new FormData();
        form.append("file", retryFile);
        form.append("model", MODEL);
        form.append("response_format", "json");
        if (language) form.append("language", language);
        ({ resp, text } = await callOpenAI(form, OPENAI_API_KEY));
        log("[STT] openai#2 (compat)", { status: resp.status, len: text?.length || 0, retryCT, retryName });
      }
    }

    if (!resp.ok) {
      let detail = text; try { detail = JSON.parse(text); } catch {}
      return json(resp.status, { error: "openai_stt_error", detail });
    }

    let data = {}; try { data = JSON.parse(text); } catch {}
    const transcript = (data.text || "").trim();

    log("[STT] parsed", {
      hasText: Boolean(transcript),
      textLen: transcript.length,
      language: data.language,
      duration: data.duration,
      segments: Array.isArray(data.segments) ? data.segments.length : 0,
    });

    return json(200, { transcript });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "openai_timeout" : (e?.message || String(e));
    log("[STT] exception", msg);
    return json(500, { error: "stt_exception", detail: msg });
  }
};
