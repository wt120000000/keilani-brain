// ~150 words/min ˜ 2.5 words/second
const { getEntitlements, bumpUsage } = require("./_entitlements.js");
const estimateSeconds = (text = "") => Math.ceil((text.split(/\s+/).length || 1) / 2.5);

module.exports = async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const userId = req.headers.get("x-user-id");
    if (!userId) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

    const body = await req.json().catch(() => ({}));
    const text = (body?.text || "").trim();
    if (!text) return new Response(JSON.stringify({ error: "text required" }), { status: 400 });

    const { ent, usage } = await getEntitlements(userId);
    const maxVoiceSec = Number(ent.voice_minutes_per_day || 0) * 60;
    if (maxVoiceSec <= 0) {
      return new Response(JSON.stringify({ error: "Voice not available for your plan", upgrade: true }), { status: 402 });
    }

    const willUse = estimateSeconds(text);
    if ((usage.voice_seconds_used || 0) + willUse > maxVoiceSec) {
      return new Response(JSON.stringify({ error: "Daily voice limit reached", upgrade: true }), {
        status: 402, headers: { "content-type": "application/json" }
      });
    }

    await bumpUsage(userId, { voiceSeconds: willUse });
    return new Response(JSON.stringify({ ok: true, seconds: willUse }), {
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};