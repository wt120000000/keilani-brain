// netlify/functions/billing-checkout.js
// Stripe checkout with robust CORS + OPTIONS preflight + env/Supabase price lookup.

const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");

// ----- CORS helpers -----
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

  // Preflight
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
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, origin, { error: "invalid_json" }); }

    const tier = String(body.tier || "").toUpperCase();
    const userId = event.headers["x-user-id"] || event.headers["X-User-Id"];
    if (!userId) return json(401, origin, { error: "unauthorized" });
    if (!["FAN","VIP","ULTRA"].includes(tier)) return json(400, origin, { error: "invalid_tier" });

    // Price lookup: ENV fallback then Supabase
    let priceId = process.env["PRICE_" + tier] || null;
    if (!priceId) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE;
      if (!url || !key) return json(500, origin, { error: "missing_price_and_supabase" });
      const sb = createClient(url, key, { auth: { persistSession: false } });
      const { data: row, error } = await sb
        .from("tier_prices")
        .select("stripe_price_id")
        .eq("tier_code", tier)
        .single();
      if (error || !row) return json(500, origin, { error: "price_not_found" });
      priceId = row.stripe_price_id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://keilani.ai/?billing=success",
      cancel_url: "https://keilani.ai/?billing=cancel",
      metadata: { userId, tier }
    });

    return json(200, origin, { url: session.url });
  } catch (e) {
    return json(500, origin, { error: String(e?.message || e) });
  }
};
