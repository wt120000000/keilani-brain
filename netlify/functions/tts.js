// netlify/functions/tts.js
// POST { text, voiceId?, model_id?, stability?, similarity_boost?, style?, use_speaker_boost? }
// Success -> { audio: "data:audio/mpeg;base64,..." }
// Errors -> { error, detail, meta } with proper HTTP status (incl. 402 for quota)

const okCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "OPTIONS, POST",
  "Content-Type": "application/json",
};

function json(statusCode, body) {
  return { statusCode, headers: okCors, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, "");
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    // Accept either env var name
    const XI_API_KEY = (process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY || "").trim();
    if (!XI_API_KEY) return json(500, { error: "missing_api_key" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "invalid_json" }); }

    const text = (body.text || "").toString();
    if (!text) return json(400, { error: "missing_text" });

    const voiceId = (body.voiceId || process.env.ELEVEN_VOICE_ID || "").trim() || "EXAVITQu4vr4xnSDxMaL"; // Sarah
    const model_id = (body.model_id || process.env.ELEVEN_TTS_MODEL || "").trim() || "eleven_turbo_v2";

    const { stability, similarity_boost, style, use_speaker_boost } = body;

    // Non-stream endpoint is more permissive; keep it.
    const synthUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

    const payload = {
      text,
      model_id,
      // Cheaper output option (comment out if you want defaults)
      // output_format: "mp3_44100_64",
      voice_settings: {
        ...(stability !== undefined ? { stability } : {}),
        ...(similarity_boost !== undefined ? { similarity_boost } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(use_speaker_boost !== undefined ? { use_speaker_boost } : {}),
      },
    };
    if (Object.keys(payload.voice_settings).length === 0) delete payload.voice_settings;

    const r = await fetch(synthUrl, {
      method: "POST",
      headers: {
        "xi-api-key": XI_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg, application/json",
      },
      body: JSON.stringify(payload),
    });

    const ct = r.headers.get("content-type") || "";
    // If Eleven returns JSON (often for errors), parse and bubble up correctly.
    if (ct.includes("application/json")) {
      const detail = await r.json().catch(() => ({}));
      const statusFromDetail =
        detail?.detail?.status || detail?.status || detail?.error || null;

      // Map known conditions to meaningful HTTP codes
      if (statusFromDetail === "quota_exceeded") {
        return json(402, { // Payment Required
          error: "quota_exceeded",
          detail,
          meta: { status: 402, voiceId, model_id, endpoint: "non-stream" },
        });
      }

      // If not OK or detail looks like an error, surface it.
      if (!r.ok || statusFromDetail) {
        return json(r.status || 500, {
          error: "eleven_error",
          detail,
          meta: { status: r.status || 500, voiceId, model_id, endpoint: "non-stream" },
        });
      }
      // If OK + JSON (rare), still treat as error to be safe.
      return json(500, {
        error: "unexpected_json_response",
        detail,
        meta: { status: r.status || 500, voiceId, model_id, endpoint: "non-stream" },
      });
    }

    if (!r.ok) {
      let detail;
      try { detail = await r.text(); } catch { detail = "<no-body>"; }
      return json(r.status || 500, {
        error: "eleven_error",
        detail,
        meta: { status: r.status || 500, voiceId, model_id, endpoint: "non-stream" },
      });
    }

    // Happy path: audio bytes
    const buf = Buffer.from(await r.arrayBuffer());
    const dataUrl = `data:audio/mpeg;base64,${buf.toString("base64")}`;
    return json(200, { audio: dataUrl, meta: { voiceId, model_id } });

  } catch (err) {
    return json(500, { error: "server_error", detail: String(err?.message || err) });
  }
};
