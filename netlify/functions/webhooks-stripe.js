const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req) => {
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const sess = event.data.object;
        const userId = sess.metadata?.userId;
        const tier = (sess.metadata?.tier || "FAN").toUpperCase();
        if (userId) {
          await sb.from("user_plans").upsert({
            user_id: userId, tier_code: tier, status: "active", valid_until: null
          });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const userId = sub.metadata?.userId; // only if you attach it to subs; optional
        if (userId) {
          await sb.from("user_plans").upsert({
            user_id: userId, tier_code: "FREE", status: "canceled", valid_until: null
          });
        }
        break;
      }
      default:
        break;
    }
    return new Response("ok");
  } catch (e) {
    return new Response(`Handler error: ${e.message}`, { status: 500 });
  }
};

module.exports.config = { path: "/.netlify/functions/webhooks-stripe" };