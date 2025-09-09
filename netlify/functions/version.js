// Shows deploy metadata (helpful for debugging which build is live)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: CORS, body: "Method Not Allowed" };
  const info = {
    ok: true,
    branch: process.env.BRANCH || null,
    commit: process.env.COMMIT_REF || null,
    deployId: process.env.DEPLOY_ID || null,
    context: process.env.CONTEXT || null,
    createdAt: new Date().toISOString(),
  };
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify(info),
  };
};
