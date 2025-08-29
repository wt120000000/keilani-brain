exports.handler = async () => {
  const raw = (
    process.env.ALLOWED_ORIGINS ||
    process.env.cors_allowed_origins ||
    process.env.CORS_ALLOWED_ORIGINS ||
    ""
  ).replace(/\s+/g, ",");

  const allowlist = raw.split(",").map(s => s.trim()).filter(Boolean);

  const checks = {
    openai: !!process.env.OPENAI_API_KEY,
    allowedOrigins: allowlist.length > 0
  };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, allowlist })
  };
};
