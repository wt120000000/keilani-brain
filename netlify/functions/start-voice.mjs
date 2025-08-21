// netlify/functions/start-voice.mjs
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const redact = v => (v ? `${String(v).slice(0,4)}…(${String(v).length})` : "MISSING");

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok:false, error:"Method Not Allowed" }) };

  const DID_API_KEY  = process.env.DID_API_KEY;
  const DID_AGENT_ID = process.env.DID_AGENT_ID;
  const SOURCE_URL   = process.env.DID_PRESENTER_IMAGE_URL; // 👈 use presenter image
  const VOICE_PROVIDER = process.env.DID_VOICE_PROVIDER || "elevenlabs";
  const VOICE_ID       = process.env.DID_VOICE_ID || "";

  console.log("start-voice env:", {
    DID_API_KEY: redact(DID_API_KEY),
    DID_AGENT_ID: DID_AGENT_ID ? "SET" : "MISSING",
    SOURCE_URL: SOURCE_URL ? "SET" : "MISSING",
    VOICE_PROVIDER, VOICE_ID: VOICE_ID ? "SET" : "MISSING",
  });

  if (!DID_API_KEY || !DID_AGENT_ID || !SOURCE_URL) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, stage:"env", error:"Missing DID_API_KEY or DID_AGENT_ID or DID_PRESENTER_IMAGE_URL" }) };
  }

  const basic = Buffer.from(`${DID_API_KEY}:`).toString("base64");

  try {
    const url = `https://api.d-id.com/agents/${encodeURIComponent(DID_AGENT_ID)}/streams`;
    const body = {
      // Use the presenter image directly so the stream has a valid face
      source_url: SOURCE_URL,
      // Set Keilani's ElevenLabs voice
      voice: VOICE_ID ? { provider: VOICE_PROVIDER, voice_id: VOICE_ID } : undefined,
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}
    console.log("D-ID create stream status:", r.status);

    if (r.status >= 400) {
      console.error("D-ID error body:", text);
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ ok:false, stage:"did:create", error:`D-ID HTTP ${r.status}`, upstream:text.slice(0,600) }),
      };
    }

    const { id, stream_id, session_id, sdp } = json || {};
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        agentId: DID_AGENT_ID,
        streamId: stream_id || id,
        sessionId: session_id || null,
        offer: sdp || null,
      }),
    };
  } catch (err) {
    console.error("start-voice fatal:", err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, stage:"did:network", error: err?.message || "unknown error" }) };
  }
};
