// netlify/functions/stt.js (CommonJS)
// POST { audioBase64, language? } -> { text }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { statusCode: 500, body: "Missing OPENAI_API_KEY" };
  }

  try {
    const { audioBase64, language } = JSON.parse(event.body || "{}");
    if (!audioBase64) return { statusCode: 400, body: "Missing audioBase64" };

    const base64 = audioBase64.split(",").pop();
    const uint8 = Uint8Array.from(Buffer.from(base64, "base64"));

    // Node 18+ has global FormData & Blob via undici
    const form = new FormData();
    form.append("file", new Blob([uint8], { type: "audio/webm" }), "audio.webm");
    form.append("model", process.env.OPENAI_STT_MODEL || "whisper-1");
    if (language) form.append("language", language);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!res.ok) {
      return { statusCode: res.status, body: await res.text() };
    }

    const data = await res.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ text: data.text || "" }),
    };
  } catch (err) {
    return { statusCode: 500, body: `stt error: ${err.message}` };
  }
};
