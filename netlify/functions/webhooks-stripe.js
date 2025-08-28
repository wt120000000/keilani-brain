const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const sig = event.headers["stripe-signature"];
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const sess = stripeEvent.data.object;
        const userId = sess.metadata?.userId;
        const tier = String(sess.metadata?.tier || "FAN").toUpperCase();
        if (userId) {
          await sb.from("user_plans").upsert({
            user_id: userId, tier_code: tier, status: "active", valid_until: null
          });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = stripeEvent.data.object;
        const userId = sub.metadata?.userId;
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
    return { statusCode: 200, body: "ok" };
  } catch (e) {
    return { statusCode: 500, body: `Handler error: ${e.message}` };
  }
};