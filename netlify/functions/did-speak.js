// Keilani — D-ID voice proxy
// Uses native fetch (Node 18+ on Netlify). No "node-fetch" needed.

const DID_API = "https://api.d-id.com";
const API_KEY = process.env.DID_API_KEY || "";             // <— set in Netlify env
const SOURCE_URL = process.env.DID_AVATAR_SOURCE_URL || ""; // <— set in Netlify env

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return ok({}, 204); // CORS preflight if needed
    }

    if (event.httpMethod === "GET") {
      // Poll talk status: /api/did-speak?id=xxx
      const id = (event.queryStringParameters?.id || "").trim();
      if (!id) return bad("Missing id");
      if (!API_KEY) return ok({ fallback: true }); // no D-ID configured

      const r = await fetch(`${DID_API}/talks/${encodeURIComponent(id)}`, {
        headers: { "Authorization": `Basic ${API_KEY}` }
      });
      const j = await r.json();

      // Shape normalization
      const status = j?.status || j?.state || "";
      const resultUrl =
        j?.result_url ||
        j?.result_url_mp4 ||
        j?.result?.url ||
        j?.audio?.url ||
        "";

      return ok({ status, result_url: resultUrl });
    }

    // POST: create a talk from text
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const text = (body.text || "").trim();
      const mode = (body.mode || "D-ID Avatar").trim();

      if (!text) return bad("Missing text");

      // If D-ID config is missing, tell client to fallback to local TTS
      if (!API_KEY || !SOURCE_URL || mode !== "D-ID Avatar") {
        return ok({ fallback: true, text });
      }

      const payload = {
        script: { type: "text", input: text },
        source_url: SOURCE_URL
      };

      const res = await fetch(`${DID_API}/talks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${API_KEY}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      // If API returns result_url right away, pass it through; otherwise return id to poll
      const resultUrl =
        data?.result_url ||
        data?.result_url_mp4 ||
        data?.result?.url ||
        data?.audio?.url ||
        "";

      if (resultUrl) return ok({ status: "done", result_url: resultUrl });
      if (data?.id) return ok({ id: data.id, status: data.status || "created" });

      // If error shape
      if (!res.ok) {
        return ok({ fallback: true, error: data }, res.status);
      }

      // Unknown but not fatal — fallback
      return ok({ fallback: true });
    }

    return bad("Method not allowed", 405);
  } catch (err) {
    return ok({ fallback: true, error: String(err) }, 200);
  }
};

// ---------- helpers ----------
function ok(json, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(json)
  };
}
function bad(msg, status = 400) {
  return ok({ error: msg }, status);
}
