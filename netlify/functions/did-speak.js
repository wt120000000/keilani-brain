// Keilani — D-ID voice proxy (audio/video aware)

const DID_API = "https://api.d-id.com";
const API_KEY = process.env.DID_API_KEY || "";
const SOURCE_URL = process.env.DID_AVATAR_SOURCE_URL || "";

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return ok({}, 204);
    }

    if (event.httpMethod === "GET") {
      const id = (event.queryStringParameters?.id || "").trim();
      if (!id) return bad("Missing id");
      if (!API_KEY) return ok({ fallback: true });

      const r = await fetch(`${DID_API}/talks/${encodeURIComponent(id)}`, {
        headers: { "Authorization": `Basic ${API_KEY}` }
      });
      const j = await r.json();

      const status = j?.status || j?.state || "";
      const resultUrl =
        j?.result_url ||
        j?.result_url_mp4 ||
        j?.result?.url ||
        j?.audio?.url ||
        "";

      return ok({ status, result_url: resultUrl });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const text = (body.text || "").trim();
      const mode = (body.mode || "D-ID Avatar").trim();

      if (!text) return bad("Missing text");

      if (!API_KEY || !SOURCE_URL || mode !== "D-ID Avatar") {
        // fall back gracefully to local tts on the client
        return ok({ fallback: true, text });
      }

      // Basic text talk request
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

      // If the API returns a ready URL right away pass it through
      const resultUrl =
        data?.result_url ||
        data?.result_url_mp4 ||
        data?.result?.url ||
        data?.audio?.url ||
        "";

      if (resultUrl) return ok({ status: "done", result_url: resultUrl });
      if (data?.id) return ok({ id: data.id, status: data.status || "created" });

      if (!res.ok) return ok({ fallback: true, error: data }, res.status);
      return ok({ fallback: true });
    }

    return bad("Method not allowed", 405);
  } catch (err) {
    return ok({ fallback: true, error: String(err) }, 200);
  }
};

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
