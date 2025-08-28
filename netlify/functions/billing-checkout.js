const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const tier = (body?.tier || url.searchParams.get("tier") || "").toUpperCase();
    const userId = req.headers.get("x-user-id");

    if (!userId) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    if (!["FAN","VIP","ULTRA"].includes(tier)) return new Response(JSON.stringify({ error: "invalid tier" }), { status: 400 });

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

    return new Response(JSON.stringify({ url: session.url }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};