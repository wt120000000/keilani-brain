// /netlify/functions/start-voice.mjs

import fetch from "node-fetch";

export async function handler(event) {
  if (!process.env.DID_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        stage: "voice",
        error: "Missing DID_API_KEY in environment",
      }),
    };
  }

  try {
    const resp = await fetch("https://api.d-id.com/v1/agents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DID_API_KEY}`,
      },
      body: JSON.stringify({
        name: "Keilani Voice",
        voice: "en-US-JennyNeural", // you can swap this voice later
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({
          ok: false,
          stage: "voice",
          error: data.error || "D-ID API error",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, agent: data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        stage: "voice",
        error: err.message,
      }),
    };
  }
}
