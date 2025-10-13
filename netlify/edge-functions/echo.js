// netlify/edge-functions/echo.js
export default async (req) => {
  // Read raw text once (no clone, no double-read)
  let text = "";
  try { text = await req.text(); } catch {}

  let json = null;
  try { json = JSON.parse(text); } catch {}

  const body = JSON.stringify({
    method: req.method,
    contentType: req.headers.get("content-type") || null,
    contentLength: req.headers.get("content-length") || null,
    text,
    json
  });

  return new Response(body, { headers: { "content-type": "application/json" } });
};
