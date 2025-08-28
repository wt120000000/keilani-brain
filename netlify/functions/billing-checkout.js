const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const body = JSON.parse(event.body || "{}");
    const tier = String(body.tier || "").toUpperCase();
    const userId = (event.headers["x-user-id"] || event.headers["X-User-Id"]);

    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
    if (!["FAN","VIP","ULTRA"].includes(tier)) return { statusCode: 400, body: JSON.stringify({ error: "invalid tier" }) };

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
    const { data: priceRow, error } = await sb.from("tier_prices").select("stripe_price_id").eq("tier_code", tier).single();
    if (error || !priceRow) throw new Error("price not found");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceRow.stripe_price_id, quantity: 1 }],
      success_url: "https://www.keilani.ai/?billing=success",
      cancel_url: "https://www.keilani.ai/?billing=cancel",
      metadata: { userId, tier }
    });

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ url: session.url }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};