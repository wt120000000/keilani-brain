module.exports = async () => {
  return new Response(JSON.stringify({ ok: true, now: new Date().toISOString() }), {
    headers: { "content-type": "application/json" }
  });
};