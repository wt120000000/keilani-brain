const { getEntitlements, bumpUsage } = require("./_entitlements.js");

module.exports = async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const userId = req.headers.get("x-user-id");
    if (!userId) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

    const body = await req.json().catch(() => ({}));
    const userMessage = (body?.message || "").trim();
    const role = (body?.role || "COMPANION").toUpperCase();
    if (!userMessage) return new Response(JSON.stringify({ error: "message required" }), { status: 400 });

    const { ent, usage } = await getEntitlements(userId);
    const maxMsgs = Number(ent.max_messages_per_day || 30);
    if ((usage.messages_used || 0) >= maxMsgs) {
      return new Response(JSON.stringify({ error: "Daily message limit reached", upgrade: true }), {
        status: 402, headers: { "content-type": "application/json" }
      });
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
    });

    if (!oaRes.ok) {
      const err = await oaRes.text();
      return new Response(JSON.stringify({ error: "openai_error", detail: err }), { status: 500 });
    }

    const data = await oaRes.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "…";

    await bumpUsage(userId, { messages: 1 });

    return new Response(JSON.stringify({ reply }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};