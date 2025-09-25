export const handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "ok", version: process.env.APP_VERSION || "dev", ts: Date.now() })
});
