const { getEntitlements, bumpUsage } = require("../lib/_entitlements.js");
// ~150 words/min ˜ 2.5 words/sec
const estimateSeconds = (text = "") => Math.ceil((text.split(/\s+/).length || 1) / 2.5);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    const userId = (event.headers["x-user-id"] || event.headers["X-User-Id"]);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };

    const body = JSON.parse(event.body || "{}");
    const text = (body.text || "").trim();
    if (!text) return { statusCode: 400, body: JSON.stringify({ error: "text required" }) };

    const { ent, usage } = await getEntitlements(userId);
    const maxVoiceSec = Number(ent.voice_minutes_per_day || 0) * 60;
    if (maxVoiceSec <= 0) return { statusCode: 402, body: JSON.stringify({ error: "Voice not available for your plan", upgrade: true }) };

    const willUse = estimateSeconds(text);
    if ((usage.voice_seconds_used || 0) + willUse > maxVoiceSec) {
      return { statusCode: 402, body: JSON.stringify({ error: "Daily voice limit reached", upgrade: true }) };
    }

    await bumpUsage(userId, { voiceSeconds: willUse });
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, seconds: willUse }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
