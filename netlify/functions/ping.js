exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, now: new Date().toISOString(), envNode: process.version })
  };
};