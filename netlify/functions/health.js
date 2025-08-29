exports.handler = async () => {
  const checks = {
    openai: !!process.env.OPENAI_API_KEY,
    allowedOrigins: !!(process.env.ALLOWED_ORIGINS || process.env.cors_allowed_origins)
  };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: Object.values(checks).every(Boolean), checks })
  };
};
