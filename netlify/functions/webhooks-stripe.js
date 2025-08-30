// netlify/functions/webhooks-stripe.js
// Stripe webhook: verifies signature, handles subscription lifecycle,
// and keeps Supabase user_plans in sync.

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(status, body) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const key = process.env.STRIPE_SECRET_KEY;
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!secret || !key || !sbUrl || !sbKey) {
      return json(500, { error: "missing_env", detail: "STRIPE_WEBHOOK_SECRET / STRIPE_SECRET_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE are required" });
    }

    // Raw body for signature verification
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;

    const sig = event.headers["stripe-signature"];
    const stripe = new Stripe(key);

    let evt;
    try {
      evt = stripe.webhooks.constructEvent(raw, sig, secret);
    } catch (err) {
      return json(400, { error: "bad_signature", detail: err.message });
    }

    const supa = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

    // helper: update/insert plan row
    async function upsertPlan(partial, match = "user_id") {
      // onConflict columns: prefer user_id if we have it, otherwise subscription_id
      const conflict = partial.user_id ? "user_id" : "subscription_id";
      const { error } = await supa
        .from("user_plans")
        .upsert(partial, { onConflict: conflict });
      if (error) throw error;
    }

    // helper: map Stripe status → our status
    const mapStatus = (s) =>
      ({
        active: "active",
        trialing: "active",
        past_due: "past_due",
        unpaid: "past_due",
        canceled: "canceled",
        incomplete: "incomplete",
        incomplete_expired: "incomplete",
        paused: "paused",
      }[s] || "active");

    switch (evt.type) {
      // When checkout finishes, we get the new sub + customer and the tier in metadata
      case "checkout.session.completed": {
        const s = evt.data.object;
        const userId = s.metadata?.userId || null;
        const tier = String(s.metadata?.tier || "FAN").toUpperCase();
        const subscription_id = s.subscription || null;
        const customer_id = s.customer || null;

        await upsertPlan({
          user_id: userId,
          tier_code: tier,
          status: "active",
          subscription_id,
          customer_id,
          valid_until: null,
        });

        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = evt.data.object;

        const customer_id = sub.customer || null;
        const subscription_id = sub.id || null;
        const status = mapStatus(sub.status);
        const tier_code =
          (sub.items?.data?.[0]?.price?.lookup_key || "").toUpperCase() || null;
        const valid_until = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;

        // Try to find our user row by customer or subscription
        const { data: existing } = await supa
          .from("user_plans")
          .select("user_id")
          .or(`customer_id.eq.${customer_id},subscription_id.eq.${subscription_id}`)
          .limit(1)
          .maybeSingle();

        await upsertPlan({
          user_id: existing?.user_id || null,
          customer_id,
          subscription_id,
          tier_code,
          status,
          valid_until,
        });

        break;
      }

      case "invoice.payment_failed": {
        const inv = evt.data.object;
        const customer_id = inv.customer || null;
        const subscription_id = inv.subscription || null;
        const { error } = await supa
          .from("user_plans")
          .update({ status: "past_due" })
          .or(`customer_id.eq.${customer_id},subscription_id.eq.${subscription_id}`);
        if (error) throw error;
        break;
      }

      case "invoice.paid": {
        const inv = evt.data.object;
        const customer_id = inv.customer || null;
        const subscription_id = inv.subscription || null;
        const { error } = await supa
          .from("user_plans")
          .update({ status: "active" })
          .or(`customer_id.eq.${customer_id},subscription_id.eq.${subscription_id}`);
        if (error) throw error;
        break;
      }

      default:
        // no-op
        break;
    }

    return json(200, { ok: true });
  } catch (e) {
    console.error("webhook handler error:", e);
    return json(500, { error: "server_error", detail: String(e?.message || e) });
  }
};
