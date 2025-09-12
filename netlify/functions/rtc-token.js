// netlify/functions/rtc-token.js (CommonJS)
// POST { room, userName?, isOwner? } -> { token }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  if (!process.env.DAILY_API_KEY) return { statusCode: 500, body: "Missing DAILY_API_KEY" };

  try {
    const { room, userName, isOwner } = JSON.parse(event.body || "{}");
    if (!room) return { statusCode: 400, body: "Missing room" };

    const res = await fetch("https://api.daily.co/v1/meeting-tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
      },
      body: JSON.stringify({
        properties: {
          room_name: room,
          user_name: userName || "Guest",
          is_owner: !!isOwner,
        },
      }),
    });

    if (!res.ok) return { statusCode: res.status, body: await res.text() };
    const data = await res.json();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ token: data.token }),
    };
  } catch (err) {
    return { statusCode: 500, body: `rtc token error: ${err.message}` };
  }
};
