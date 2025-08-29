const { getEntitlements, bumpUsage } = require("../lib/_entitlements.js");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const dry = event.queryStringParameters && event.queryStringParameters.dry;
    const userId = (event.headers["x-user-id"] || event.headers["X-User-Id"]);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };

    const body = JSON.parse(event.body || "{}");
    const userMessage = (body.message || "").trim();
    const role = (body.role || "COMPANION").toUpperCase();
    if (!userMessage) return { statusCode: 400, body: JSON.stringify({ error: "message required" }) };

    const { ent, usage } = await getEntitlements(userId);
    const maxMsgs = Number(ent.max_messages_per_day || 30);
    if ((usage.messages_used || 0) >= maxMsgs) {
      return { statusCode: 402, body: JSON.stringify({ error: "Daily message limit reached", upgrade: true }) };
    }

    if (dry) {
      await bumpUsage(userId, { messages: 1 });
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ reply: `[dry] ${userMessage}` }) };
    }

    const systemByRole = {
      COMPANION: "You are Keilani: playful, kind, supportive. Keep replies short and warm.",
      MENTOR: "You are Keilani: practical, compassionate coach. No medical/legal advice.",
      GAMER: "You are Keilani: hype gamer friend and coach. Be energetic and tactical.",
      CREATOR: "You are Keilani: creative strategist; suggest hooks, formats, and trends.",
      POLYGLOT: "You are Keilani: language buddy; be encouraging and correct gently.",
      CUSTOM: "You are Keilani: use the user's saved preferences to mirror their style."
    };
    const system = systemByRole[role] || systemByRole.COMPANION;

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (!process.env.OPENAI_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "openai_error", detail: "OPENAI_API_KEY missing" }) };
    }

    // 15s timeout safety
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error("timeout")), 15000);

    const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMessage }
        ],
        temperature: 0.8,
        max_tokens: 400
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(t));

    if (!oaRes.ok) {
      const err = await oaRes.text().catch(() => "");
      return { statusCode: 500, body: JSON.stringify({ error: "openai_error", detail: err }) };
    }

    const data = await oaRes.json().catch(() => ({}));
    const reply = data?.choices?.[0]?.message?.content?.trim() || "…";

    await bumpUsage(userId, { messages: 1 });

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ reply }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
// touch: 2025-08-27T20:15:25.1596579-07:00

