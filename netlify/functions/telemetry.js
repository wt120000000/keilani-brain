// netlify/functions/telemetry.js
// POST { events: [{ type, ts, data }...] } | { type, ts, data }
// Logs to Netlify function logs so you can tail/inspect in the UI or `netlify logs:function telemetry`

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

const j = (status, body) => ({
  statusCode: status,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return j(405, { error: "method_not_allowed" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return j(400, { error: "invalid_json" }); }

    const now = new Date().toISOString();
    const ip  = event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "unknown";

    const events = Array.isArray(body?.events) ? body.events
                 : body?.type ? [body]
                 : [];

    if (!events.length) return j(400, { error: "no_events" });

    for (const e of events) {
      const rec = {
        ts: e.ts || now,
        type: String(e.type || "unknown"),
        ip,
        ua: event.headers["user-agent"] || "",
        data: e.data || null,
      };
      // Log compact single-line JSON (easy to grep)
      console.log("[telemetry]", JSON.stringify(rec));
    }

    // No payload needed
    return {
      statusCode: 204,
      headers: CORS,
      body: "",
    };
  } catch (err) {
    console.error("[telemetry] exception", err);
    return j(500, { error: "telemetry_exception", detail: String(err?.message || err) });
  }
};
