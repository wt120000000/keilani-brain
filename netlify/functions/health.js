// CommonJS health endpoint at /api/health
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: CORS, body: "Method Not Allowed" };
  const now = new Date().toISOString();
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify({ ok: true, time: now, region: process.env.AWS_REGION || null }),
  };
};
