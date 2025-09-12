// netlify/functions/rtc-create-room.js (CommonJS)

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
  if (!process.env.DAILY_API_KEY || !process.env.DAILY_DOMAIN) {
    return { statusCode: 500, body: "Missing DAILY_API_KEY or DAILY_DOMAIN" };
  }

  try {
    const { name } = JSON.parse(event.body || "{}");
    const roomName = name || `keilani-${Math.random().toString(36).slice(2, 8)}`;
    const expMin = parseInt(process.env.DAILY_ROOM_EXP_MINUTES || "120", 10);
    const exp = Math.round(Date.now() / 1000) + expMin * 60;

    const res = await fetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
      },
      body: JSON.stringify({
        name: roomName,
        properties: {
          exp,
          enable_screenshare: true,
          enable_chat: true,
          enable_knocking: false,
          start_video_off: false,
          start_audio_off: false,
        },
      }),
    });

    if (!res.ok) return { statusCode: res.status, body: await res.text() };
    const data = await res.json();
    const url = `https://${process.env.DAILY_DOMAIN}/${data.name}`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ room: data.name, url }),
    };
  } catch (err) {
    return { statusCode: 500, body: `rtc create error: ${err.message}` };
  }
};
