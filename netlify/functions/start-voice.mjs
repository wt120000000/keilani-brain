// netlify/functions/start-voice.mjs
// Creates a D-ID Agent WebRTC stream and returns the server's SDP offer.
// Auth: Basic base64("DID_API_KEY:")

const cors = {
  "Access-Control-Allow-Origin": "*", // tighten later
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const redact = v => (v ? `${String(v).slice(0,4)}…(${String(v).length})` : "MISSING");

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok:false, error:"Method Not Allowed" }) };
  }

  const DID_API_KEY  = process.env.DID_API_KEY;
  const DID_AGENT_ID = process.env.DID_AGENT_ID;
  const DID_REGION   = process.env.DID_REGION || "us";

  console.log("start-voice env:", {
    DID_API_KEY: redact(DID_API_KEY),
    DID_AGENT_ID: DID_AGENT_ID ? "SET" : "MISSING",
    DID_REGION,
  });

  if (!DID_API_KEY || !DID_AGENT_ID) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok:false, stage:"env", error:"Missing DID_API_KEY or DID_AGENT_ID" }),
    };
  }

  // Basic auth is apiKey + ":" (no password)
  const basic = Buffer.from(`${DID_API_KEY}:`).toString("base64");

  try {
    // Create a new WebRTC stream for your Agent
    const url = `https://api.d-id.com/agents/${encodeURIComponent(DID_AGENT_ID)}/streams`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/json",
        "x-did-region": DID_REGION, // optional
      },
      body: JSON.stringify({}),
    });

    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}

    console.log("D-ID create stream status:", r.status);
    if (r.status >= 400) {
      console.error("D-ID error body:", text);
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

    const { id, stream_id, session_id, sdp } = json || {};
    if (!sdp?.sdp) console.warn("No SDP in D-ID response:", json);

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        agentId: DID_AGENT_ID,
        streamId: stream_id || id,
        sessionId: session_id || null,
        offer: sdp || null, // { type:"offer", sdp:"..." }
        region: DID_REGION,
      }),
    };
  } catch (err) {
    console.error("start-voice fatal:", err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok:false, stage:"did:network", error: err?.message || "unknown error" }),
    };
  }
};
