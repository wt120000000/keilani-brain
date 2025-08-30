// netlify/functions/billing-checkout.js
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "method_not_allowed" };

  try {
    const body = JSON.parse(event.body || "{}");
    const tier = String(body.tier || body.plan || "FAN").toUpperCase(); // FAN | VIP | ULTRA
    const userId = event.headers["x-user-id"] || event.headers["X-User-Id"];
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession:false } });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // get price id from your table, fallback to env
    let priceId;
    const { data: priceRow } = await sb.from("tier_prices").select("stripe_price_id").eq("tier_code", tier).single();
    priceId = priceRow?.stripe_price_id ||
      (tier === "ULTRA" ? process.env.PRICE_ULTRA :
       tier === "VIP"   ? process.env.PRICE_VIP   :
                          process.env.PRICE_FAN);

    if (!priceId) return { statusCode: 400, body: JSON.stringify({ error: "missing price id" }) };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://keilani.ai/engage?billing=success",
      cancel_url:  "https://keilani.ai/engage?billing=cancel",
      client_reference_id: userId,
      metadata: { userId, tier }
    });

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ url: session.url }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
