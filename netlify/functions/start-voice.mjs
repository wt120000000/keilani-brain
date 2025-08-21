// netlify/functions/start-voice.mjs
// Creates a new D-ID Agent WebRTC stream and returns the server SDP offer
// Env needed in Netlify (Site → Settings → Environment):
//   DID_API_KEY            = <your D-ID API key>
//   DID_AGENT_ID           = <your D-ID Agent ID>
// Optional:
//   DID_REGION             = "eu" | "us"  (defaults to "us")

const cors = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain later
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const redact = (v) => (v ? `${String(v).slice(0,4)}…(${String(v).length})` : "MISSING");

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ ok: false, error: "Method Not Allowed" }),
    };
  }

  const DID_API_KEY  = process.env.DID_API_KEY;
  const DID_AGENT_ID = process.env.DID_AGENT_ID;
  const DID_REGION   = process.env.DID_REGION || "us"; // "us" or "eu"

  console.log("start-voice env:", {
    DID_API_KEY: redact(DID_API_KEY),
    DID_AGENT_ID: DID_AGENT_ID ? "SET" : "MISSING",
    DID_REGION,
  });

  if (!DID_API_KEY || !DID_AGENT_ID) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, stage: "env", error: "Missing DID_API_KEY or DID_AGENT_ID" }),
    };
  }

  // Basic auth is "Base64(apiKey:)" per D-ID docs
  const basic = Buffer.from(`${DID_API_KEY}:`).toString("base64");

  try {
    // 1) Create a new WebRTC stream for the Agent
    // POST https://api.d-id.com/agents/{agentId}/streams
    // Docs: Create a new stream → returns { stream_id, session_id, sdp: { type:"offer", sdp:"..." }, ... }
    const createUrl = `https://api.d-id.com/agents/${encodeURIComponent(DID_AGENT_ID)}/streams`;
    const r = await fetch(createUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/json",
        // Some accounts are region-specific; D-ID honors geo via the auth, but keeping region for future options:
        "x-did-region": DID_REGION,
      },
      body: JSON.stringify({
        // Optional: you can preconfigure voice/presenter here if your Agent allows overrides.
        // voice: { provider: "elevenlabs", voice_id: "..." },
        // video: { presenter_id: "..." },
      }),
    });

    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { /* keep raw text for logging */ }

    console.log("D-ID create stream status:", r.status);
    if (r.status >= 400) {
      console.error("D-ID create stream error body:", text);
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({
          ok: false,
          stage: "did:create",
          error: `D-ID HTTP ${r.status}`,
          upstream: text.slice(0, 600),
        }),
      };
    }

    // Expect at least: { id/stream_id, session_id, sdp: { type:"offer", sdp:"..." } }
    const { id, stream_id, session_id, sdp } = json || {};
    if (!sdp?.sdp) {
      console.warn("No SDP in D-ID response:", json);
    }

    // Return the minimum the browser needs to complete the offer/answer exchange.
    // The client will:
    //  - create a RTCPeerConnection
    //  - setRemoteDescription(offer)
    //  - createAnswer() / setLocalDescription()
    //  - POST the answer back to D-ID using the /sdp endpoint (you can proxy that too if you prefer)
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        agentId: DID_AGENT_ID,
        streamId: stream_id || id, // D-ID sometimes uses "id" vs "stream_id"
        sessionId: session_id || null,
        offer: sdp || null,        // { type: "offer", sdp: "..." }
        region: DID_REGION,
      }),
    };
  } catch (err) {
    console.error("start-voice fatal:", err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, stage: "did:network", error: err?.message || "unknown error" }),
    };
  }
};
