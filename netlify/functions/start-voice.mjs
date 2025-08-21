// netlify/functions/start-voice.mjs
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const redact = v => (v ? `${String(v).slice(0,4)}…(${String(v).length})` : "MISSING");

async function createStream({ apiKey, agentId, body }) {
  const basic = Buffer.from(`${apiKey}:`).toString("base64");
  const url = `https://api.d-id.com/agents/${encodeURIComponent(agentId)}/streams`;
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
  return { ok: r.status < 400, status: r.status, json, text };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok:false, error:"Method Not Allowed" }) };

  const DID_API_KEY  = process.env.DID_API_KEY;
  const DID_AGENT_ID = process.env.DID_AGENT_ID;
  const SOURCE_URL   = process.env.DID_PRESENTER_IMAGE_URL; // clips presenter image
  const PRESENTER_ID = process.env.DID_PRESENTER_ID;        // clips presenter id
  const VOICE_PROVIDER = process.env.DID_VOICE_PROVIDER || "elevenlabs";
  const VOICE_ID       = process.env.DID_VOICE_ID || "";

  console.log("start-voice env:", {
    DID_API_KEY: redact(DID_API_KEY),
    DID_AGENT_ID: DID_AGENT_ID ? "SET" : "MISSING",
    SOURCE_URL: SOURCE_URL ? "SET" : "MISSING",
    PRESENTER_ID: PRESENTER_ID ? "SET" : "MISSING",
    VOICE_PROVIDER, VOICE_ID: VOICE_ID ? "SET" : "MISSING",
  });

  if (!DID_API_KEY || !DID_AGENT_ID || (!SOURCE_URL && !PRESENTER_ID)) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, stage:"env", error:"Missing required D-ID envs" }) };
  }

  // Body Shape A: source_url (per official docs)
  const bodyA = {
    ...(SOURCE_URL ? { source_url: SOURCE_URL } : {}),
    ...(VOICE_ID ? { voice: { provider: VOICE_PROVIDER, voice_id: VOICE_ID } } : {}),
  };

  // Body Shape B: presenter_id (alternate)
  const bodyB = {
    ...(PRESENTER_ID ? { presenter_id: PRESENTER_ID } : {}),
    ...(VOICE_ID ? { voice: { provider: VOICE_PROVIDER, voice_id: VOICE_ID } } : {}),
  };

  try {
    // Try A first
    let res = await createStream({ apiKey: DID_API_KEY, agentId: DID_AGENT_ID, body: bodyA });

    // If A fails, try B once
    if (!res.ok && PRESENTER_ID) {
      console.warn("Create stream with source_url failed; retrying with presenter_id. Upstream:", res.text?.slice(0,600));
      res = await createStream({ apiKey: DID_API_KEY, agentId: DID_AGENT_ID, body: bodyB });
    }

    if (!res.ok) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({
          ok: false,
          stage: "did:create",
          error: `D-ID HTTP ${res.status}`,
          upstream: (res.text || "").slice(0, 800),
          tried: { source_url: !!SOURCE_URL, presenter_id: !!PRESENTER_ID }
        }),
      };
    }

    const { id, stream_id, session_id, sdp } = res.json || {};
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
