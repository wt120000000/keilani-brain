const Stripe = require("stripe");
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "method_not_allowed" };
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { customerId } = JSON.parse(event.body || "{}");
    if (!customerId) return { statusCode: 400, body: "customerId required" };
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: "https://keilani.ai/engage?billing=back"
    });
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ url: session.url }) };
  } catch (e) { return { statusCode: 500, body: e.message }; }
};
