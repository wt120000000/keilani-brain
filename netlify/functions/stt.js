// netlify/functions/stt.js
// POST { audioBase64: "<base64 or data URL>", language?: "en", mime?: "audio/webm;codecs=opus", filename?: "audio.webm" }
// -> { transcript, meta? }

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

  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";
  if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

  // ---------- Parse body ----------
  let audioBase64 = "";
  let mimeHint = "";
  let filenameHint = "";
  let language;

  try {
    const body = JSON.parse(event.body || "{}");
    const raw = (body.audioBase64 || "").trim();
    language = body.language || undefined;
    mimeHint = (body.mime || "").toLowerCase();
    filenameHint = (body.filename || "").trim();

    if (!raw) return json(400, { error: "missing_audio" });

    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      if (comma < 0) return json(400, { error: "bad_data_url" });
      const header = raw.slice(0, comma);
      audioBase64 = raw.slice(comma + 1);
      const m = header.match(/^data:([^;]+)/);
      if (m) mimeHint = (m[1] || "").toLowerCase();
    } else {
      audioBase64 = raw;
    }
  } catch (e) {
    return json(400, { error: "invalid_json", detail: String(e.message || e) });
  }

  // ---------- Decode & validate ----------
  let buf;
  try {
    buf = Buffer.from(audioBase64, "base64");
  } catch (e) {
    return json(400, { error: "bad_base64", detail: String(e.message || e) });
  }

  if (!buf || buf.length < 4000) {
    return json(400, {
      error: "audio_too_small",
      detail: "Audio is too short or truncated; send a complete utterance (>= 8KB recommended).",
      meta: { bytes: buf?.length || 0 },
    });
  }

  // ---------- Sniff magic bytes ----------
  const magic = buf.slice(0, 12);
  const hex = magic.toString("hex");

  const isWav = magic.toString("ascii", 0, 4) === "RIFF" && magic.toString("ascii", 8, 12) === "WAVE";
  const isOgg = magic.toString("ascii", 0, 4) === "OggS";
  const isWebm = hex.startsWith("1a45dfa3");  // EBML
  const isMp4 = magic.toString("ascii", 4, 8) === "ftyp"; // mp4/m4a/iso-bmff

  let inferredMime =
    isWav ? "audio/wav" :
    isOgg ? "audio/ogg" :
    isWebm ? "audio/webm" :
    isMp4 ? "audio/m4a" : "";

  // Normalize mimeHint like "audio/webm;codecs=opus" -> "audio/webm"
  if (mimeHint) {
    const semi = mimeHint.indexOf(";");
    if (semi > -1) mimeHint = mimeHint.slice(0, semi);
  }

  const finalMime = (mimeHint || inferredMime || "application/octet-stream").toLowerCase();

  const fileName =
    filenameHint ||
    (finalMime.includes("wav") ? "audio.wav" :
     finalMime.includes("mp3") ? "audio.mp3" :
     finalMime.includes("m4a") || finalMime.includes("mp4") ? "audio.m4a" :
     finalMime.includes("ogg") ? "audio.ogg" :
     finalMime.includes("webm") ? "audio.webm" :
     "audio.bin");

  // ---------- Helpers ----------
  const shouldRetry = (status, text) => {
    if (status === 429) return true;
    if (status >= 500) return true;
    if (status === 400 && /timeout|too\s+short|malformed/i.test(text || "")) return true;
    return false;
  };

  const backoff = (attempt) =>
    new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100)));

  function buildForm() {
    const form = new FormData();
    const blob = new Blob([buf], { type: finalMime });
    form.append("file", blob, fileName);
    form.append("model", MODEL);
    // Whisper supports these fields; harmless for 4o transcribe too
    form.append("response_format", "json");
    if (language) form.append("language", String(language));
    return form;
  }

  // ---------- Call OpenAI with retries (rebuild form each time) ----------
  const MAX_TRIES = 3;
  let lastStatus = 0;
  let lastText = "";

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
      const form = buildForm();
      const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
      });

      lastStatus = resp.status;
      const text = await resp.text();
      lastText = text;

      if (!resp.ok) {
        if (shouldRetry(resp.status, text) && attempt < MAX_TRIES - 1) {
          await backoff(attempt);
          continue;
        }
        return json(resp.status, {
          error: "openai_stt_error",
          detail: safeParse(text) || text,
          meta: { bytes: buf.length, mime: finalMime, model: MODEL, status: resp.status },
        });
      }

      const data = safeParse(text) || { text: "" };
      return json(200, {
        transcript: data.text || "",
        meta: { bytes: buf.length, mime: finalMime, model: MODEL, magic: summarizeMagic(magic) },
      });
    } catch (e) {
      lastStatus = -1;
      lastText = String(e?.message || e);
      if (attempt < MAX_TRIES - 1) {
        await backoff(attempt);
        continue;
      }
      return json(502, {
        error: "stt_exception",
        detail: lastText,
        meta: { bytes: buf.length, mime: finalMime, model: MODEL },
      });
    }
  }

  return json(502, {
    error: "stt_failed",
    detail: lastText || "Unknown STT failure",
    meta: { status: lastStatus },
  });
};

/* ---------------- helpers ---------------- */

function safeParse(t) {
  try { return JSON.parse(t); } catch { return null; }
}

function summarizeMagic(b) {
  try { return b.toString("hex").slice(0, 16); } catch { return ""; }
}
