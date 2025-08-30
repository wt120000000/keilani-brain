// netlify/functions/billing-checkout.js
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");

const RAW_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || "").replace(/\s+/g, ",");
const ALLOWLIST = RAW_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
const cors = (origin="") => {
  const allow = ALLOWLIST.includes(origin) ? origin : (ALLOWLIST[0] || "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-User-Id,x-user-id",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
  };
};
const json = (code, origin, obj) => ({ statusCode: code, headers: cors(origin), body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(origin), body: "" };
  if (event.httpMethod !== "POST")  return json(405, origin, { error: "method_not_allowed" });

  try {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return json(500, origin, { error: "stripe_key_missing" });
    const stripe = new Stripe(key);

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, origin, { error: "invalid_json" }); }

    const tier = String(body.tier || "").toUpperCase();
    const userId = event.headers["x-user-id"] || event.headers["X-User-Id"];
    if (!userId) return json(401, origin, { error: "unauthorized" });
    if (!["FAN","VIP","ULTRA"].includes(tier)) return json(400, origin, { error: "invalid_tier" });

    // Resolve price by lookup_key first, then env, then Supabase
    let priceId = null;
    try {
      const list = await stripe.prices.list({ lookup_keys: [tier], limit: 1, expand: ["data.product"] });
      if (list?.data?.length) priceId = list.data[0].id;
    } catch {}
    if (!priceId) priceId = process.env["PRICE_" + tier] || null;
    if (!priceId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE) {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
      const { data: row } = await sb.from("tier_prices").select("stripe_price_id").eq("tier_code", tier).single();
      if (row?.stripe_price_id) priceId = row.stripe_price_id;
    }
    if (!priceId) return json(500, origin, { error: "price_not_configured", detail: `No price for ${tier}` });

    // Safety: ensure price exists under this key/mode
    try { await stripe.prices.retrieve(priceId); } catch (e) {
      return json(500, origin, { error: "price_unavailable_for_key", detail: e?.message || String(e) });
    }

    // Build a short-lived idempotency key (per user+tier per minute)
    const minuteBucket = Math.floor(Date.now() / 60000);
    const idempotencyKey = `co:${userId}:${tier}:${minuteBucket}`;

    const sessionParams = {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://keilani.ai/?billing=success",
      cancel_url: "https://keilani.ai/?billing=cancel",
      client_reference_id: userId,          // ties session to user
      metadata: { userId, tier }
    };

    const session = await stripe.checkout.sessions.create(
      sessionParams,
      { idempotencyKey }                    // Stripe dedupes repeats in the window
    );

    return json(200, origin, { url: session.url });
  } catch (e) {
    return json(500, origin, { error: String(e?.message || e) });
  }
};
