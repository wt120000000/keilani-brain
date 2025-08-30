// netlify/functions/webhooks-stripe.js
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const PLAN_LIMITS = { FREE: 30, FAN: 100, VIP: 300, ULTRA: 1000 };

exports.handler = async (event) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession:false } });

  const sig = event.headers["stripe-signature"];
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;

  let evt;
  try {
    evt = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    if (evt.type === "checkout.session.completed") {
      const s = evt.data.object;
      const userId = s.client_reference_id || s.metadata?.userId;
      const tier = String(s.metadata?.tier || "FAN").toUpperCase();
      if (userId) {
        // map to subscriptions + entitlements
        await sb.from("subscriptions").upsert({
          user_id: userId,
          stripe_customer_id: s.customer,
          stripe_subscription_id: s.subscription,
          plan: tier.toLowerCase(),
          status: "active",
          current_period_end: null
        });
        await sb.from("entitlements").upsert({
          user_id: userId,
          plan: tier.toLowerCase(),
          max_messages_per_day: PLAN_LIMITS[tier] ?? 100
        });
        // keep your legacy table in sync if present
        await sb.from("user_plans").upsert({ user_id: userId, tier_code: tier, status: "active", valid_until: null }).catch(()=>{});
      }
    }

    if (evt.type === "customer.subscription.updated" || evt.type === "customer.subscription.created") {
      const sub = evt.data.object;
      // find user_id by subscription id
      const { data: row } = await sb.from("subscriptions").select("user_id").eq("stripe_subscription_id", sub.id).single();
      const userId = row?.user_id;
      if (userId) {
        // derive tier from price if metadata missing
        const priceId = sub.items?.data?.[0]?.price?.id || "";
        let tier = "VIP"; // default
        if (priceId === process.env.PRICE_ULTRA) tier = "ULTRA";
        if (priceId === process.env.PRICE_FAN)   tier = "FAN";

        await sb.from("subscriptions").upsert({
          user_id: userId,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          plan: tier.toLowerCase(),
          status: sub.status,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
        });

        await sb.from("entitlements").upsert({
          user_id: userId,
          plan: tier.toLowerCase(),
          max_messages_per_day: PLAN_LIMITS[tier] ?? 100
        });

        await sb.from("user_plans").upsert({ user_id: userId, tier_code: tier, status: sub.status, valid_until: null }).catch(()=>{});
      }
    }

    if (evt.type === "customer.subscription.deleted") {
      const sub = evt.data.object;
      const { data: row } = await sb.from("subscriptions").select("user_id").eq("stripe_subscription_id", sub.id).single();
      const userId = row?.user_id;
      if (userId) {
        await sb.from("subscriptions").upsert({
          user_id: userId,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          plan: "free",
          status: "canceled",
          current_period_end: null
        });
        await sb.from("entitlements").upsert({ user_id: userId, plan: "free", max_messages_per_day: PLAN_LIMITS.FREE });
        await sb.from("user_plans").upsert({ user_id: userId, tier_code: "FREE", status: "canceled", valid_until: null }).catch(()=>{});
      }
    }

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    return { statusCode: 500, body: `Handler error: ${e.message}` };
  }
};
