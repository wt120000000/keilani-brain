// netlify/functions/did-speak.js
// Runtime: Netlify Functions on Node 18+ (global fetch available)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const handler = async (event) => {
  try {
    // CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: CORS, body: "" };
    }

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: CORS,
        body: JSON.stringify({ error: "Method not allowed. Use POST." }),
      };
    }

    const env = process.env || {};
    const DID_AGENT_KEY = env.DID_AGENT_KEY;
    const DID_AGENT_ID  = env.DID_AGENT_ID;

    // Parse input
    let payload = {};
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      // ignore, will handle below
    }

    const text = (payload.text || "").toString().trim();
    const mode = (payload.mode || "D-ID Voice").toString();

    if (!text) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "Missing \"text\" in request body." }),
      };
    }

    // If we have Agent creds, hit the Agent API
    if (DID_AGENT_KEY && DID_AGENT_ID) {
      // D-ID Agent “interact” endpoint
      const url = `https://agent.d-id.com/v2/agents/${encodeURIComponent(DID_AGENT_ID)}/interact`;

      // Minimum shape that works with Agents today:
      // { input: { text: "..." } }
      // (Agent behavior—voice/video, TTS, etc.—is controlled by the Agent’s configuration)
      const body = {
        input: { text },
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DID_AGENT_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      // Try to parse payload; if not JSON, return text
      const contentType = res.headers.get("content-type") || "";
      let data;
      if (contentType.includes("application/json")) {
        data = await res.json();
      } else {
        data = { text: await res.text() };
      }

      if (!res.ok) {
        return {
          statusCode: res.status,
          headers: CORS,
          body: JSON.stringify({
            ok: false,
            used: "agent",
            status: res.status,
            data,
          }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: true,
          used: "agent",
          mode,
          request: { text },
          data,
        }),
      };
    }

    // No Agent creds → tell the UI to fall back to local SpeechSynthesis
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({
        fallback: true,
        reason: "DID_AGENT_KEY / DID_AGENT_ID not set",
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "did-speak failed", message: String(err) }),
    };
  }
};
