// netlify/functions/billing-portal.js
// Stripe Billing Portal with robust CORS + OPTIONS preflight.

const Stripe = require("stripe");

// ----- CORS helpers (same as chat.js) -----
const RAW_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ||
  process.env.ALLOWED_ORIGINS ||
  ""
).replace(/\s+/g, ",");
const ALLOWLIST = RAW_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);

function corsHeaders(origin = "") {
  const allowOrigin = ALLOWLIST.includes(origin) ? origin : (ALLOWLIST[0] || "*");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-User-Id,x-user-id",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8"
  };
}
function json(statusCode, origin, obj) {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, origin, { error: "method_not_allowed" });
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return json(500, origin, { error: "stripe_key_missing" });
    }
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, origin, { error: "invalid_json" }); }
    const customerId = body.customerId;
    if (!customerId) return json(400, origin, { error: "customerId_required" });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: "https://keilani.ai/engage?billing=back"
    });

    return json(200, origin, { url: session.url });
  } catch (e) {
    return json(500, origin, { error: String(e?.message || e) });
  }
};
