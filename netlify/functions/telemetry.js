// netlify/functions/telemetry.js (CJS)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "method_not_allowed" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const ua = event.headers["user-agent"] || "";
  console.log("[telemetry]", { ...body, ua });

  const mid = process.env.GA_MEASUREMENT_ID;
  const secret = process.env.GA_API_SECRET;

  if (mid && secret && body?.type) {
    try {
      const payload = {
        client_id: body.clientId || "anon",
        events: [
          {
            name: body.type,
            params: {
              level: body.level || "info",
              message: body.message || "",
              ...(Object.fromEntries(Object.entries(body.context || {}).map(([k, v]) => [k, String(v).slice(0, 100)]))),
            },
          },
        ],
      };
      await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${mid}&api_secret=${secret}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.warn("[telemetry] GA forward failed", e);
    }
  }

  return {
    statusCode: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  };
};
