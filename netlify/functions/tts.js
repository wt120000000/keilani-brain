// netlify/functions/tts.js
const fetch = require("node-fetch");

exports.handler = async (event) => {
  try {
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
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const { text, emotion } = JSON.parse(event.body);

    // Default emotion values
    let { stability = 0.5, similarity = 0.75, style = 0.5 } = emotion || {};

    // Clamp + normalize to [0.0–1.0]
    const clamp = (v) => Math.max(0.0, Math.min(1.0, parseFloat(v) || 0.5));
    stability = clamp(stability);
    similarity = clamp(similarity);
    style = clamp(style);

    const voiceId = process.env.ELEVENLABS_VOICE_ID || "your-voice-id";
    const apiKey = process.env.ELEVENLABS_API_KEY;

    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability,
          similarity_boost: similarity,
          style,
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return {
        statusCode: resp.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "tts_eleven_error", detail: err }),
      };
    }

    const arrayBuffer = await resp.arrayBuffer();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Access-Control-Allow-Origin": "*",
      },
      body: Buffer.from(arrayBuffer).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "tts_function_error", detail: err.message }),
    };
  }
};
