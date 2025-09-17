// netlify/functions/stt.js
// POST { audioBase64: "<base64 or data URL>", language?: "en" } -> { transcript, meta? }
// - Uses native fetch/FormData (Node 18) – no external deps.
// - Content-type sniffing (WAV/OGG/WEBM/MP3/M4A).
// - Validates minimum size; retries on 429/5xx with backoff.
// - response_format=json (compatible with whisper-1 and gpt-4o-mini-transcribe).

/* Utility: JSON response helper */
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
  // Default to whisper-1 if you prefer, or gpt-4o-mini-transcribe
  const MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";

  if (!OPENAI_API_KEY) return json(500, { error: "missing_openai_key" });

  // ---------- Parse body ----------
  let audioBase64 = "";
  let mimeHint = ""; // we'll try to infer if empty
  let language = undefined;

  try {
    const body = JSON.parse(event.body || "{}");
    const raw = (body.audioBase64 || "").trim();
    language = body.language || undefined;

    if (!raw) return json(400, { error: "missing_audio" });

    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      if (comma < 0) return json(400, { error: "bad_data_url" });
      const header = raw.slice(0, comma);
      audioBase64 = raw.slice(comma + 1);
      const m = header.match(/^data:([^;]+)/);
      if (m) mimeHint = (m[1] || "").toLowerCase();
    } else {
      // Plain base64, no data URL
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

  // Below ~2–3 KB, Whisper tends to return empty/format errors
  if (!buf || buf.length < 4000) {
    return json(400, {
      error: "audio_too_small",
      detail: "Audio is too short or truncated; capture a bit more speech.",
      meta: { bytes: buf?.length || 0 },
    });
  }

  // ---------- Sniff magic bytes to tighten mime ----------
  const magic = buf.slice(0, 12);
  const sig = magic.toString("hex");

  // WAV = "RIFF" .... "WAVE" (52 49 46 46 / 57 41 56 45 in ascii)
  const isWav = magic.toString("ascii", 0, 4) === "RIFF" && magic.toString("ascii", 8, 12) === "WAVE";
  // OGG = "OggS"
  const isOgg = magic.toString("ascii", 0, 4) === "OggS";
  // WebM/Matroska starts with EBML header 1A45DFA3
  const isWebm = sig.startsWith("1a45dfa3");
  // MP4/M4A often contains "ftyp" at offset 4
  const isMp4 = magic.toString("ascii", 4, 8) === "ftyp";

  let inferredMime =
    isWav ? "audio/wav" :
    isOgg ? "audio/ogg" :
    isWebm ? "audio/webm" :
    isMp4 ? "audio/m4a" : "";

  // Prefer explicit hint from Data URL if present; otherwise use sniffed type
  const finalMime = (mimeHint || inferredMime || "application/octet-stream").toLowerCase();

  const fileName =
    finalMime.includes("wav") ? "audio.wav" :
    finalMime.includes("mp3") ? "audio.mp3" :
    finalMime.includes("m4a") || finalMime.includes("mp4") ? "audio.m4a" :
    finalMime.includes("ogg") ? "audio.ogg" :
    finalMime.includes("webm") ? "audio.webm" :
    "audio.bin";

  // ---------- Build multipart form (native FormData/Blob) ----------
  // Node 18+: global FormData & Blob available
  const form = new FormData();
  const blob = new Blob([buf], { type: finalMime });
  form.append("file", blob, fileName);
  form.append("model", MODEL);
  form.append("response_format", "json");
  if (language) form.append("language", String(language));

  // ---------- Retry helper ----------
  const shouldRetry = (status, text) => {
    if (status === 429) return true;                   // rate limit
    if (status >= 500) return true;                    // server hiccups
    // Some transient parsing errors are worth a single retry
    if (status === 400 && /timeout|too\s+short/i.test(text || "")) return true;
    return false;
  };

  const backoff = (attempt) =>
    new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100)));

  // ---------- Call OpenAI w/ backoff ----------
  const MAX_TRIES = 3;
  let lastStatus = 0;
  let lastText = "";

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
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
        // Non-retryable failure
        return json(resp.status, {
          error: "openai_stt_error",
          detail: safeParse(text) || text,
          meta: {
            bytes: buf.length,
            mime: finalMime,
            model: MODEL,
            status: resp.status,
          },
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

  // Shouldn’t reach here
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
