// netlify/functions/chat.js
// CommonJS

let _fetch = global.fetch;
if (!_fetch) {
  try { _fetch = require("node-fetch"); }
  catch { throw new Error("Need Node 18+ (global.fetch) or add node-fetch"); }
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-client-token",
};

const ok = (data, extra = {}) => ({
  statusCode: 200,
  headers: { "content-type": "application/json; charset=utf-8", ...cors, ...extra },
  body: JSON.stringify(data),
});
const err = (code, data, extra = {}) => ({
  statusCode: code,
  headers: { "content-type": "application/json; charset=utf-8", ...cors, ...extra },
  body: typeof data === "string" ? JSON.stringify({ error: data }) : JSON.stringify(data),
});

// ---- model helpers ----
const modelOmitsTemperature = (m) => {
  const s = String(m || "").toLowerCase();
  return s === "gpt-5" || s.startsWith("gpt-5:");
};
const buildUpstreamBody = ({ message, model, temperature, stream }) => {
  const body = { message, model, stream: !!stream };
  if (!modelOmitsTemperature(model) && typeof temperature === "number" && Number.isFinite(temperature)) {
    body.temperature = temperature;
  }
  return body;
};

// ---- routing helpers ----
const isOpenAIStyle = (hdr) => /^Bearer\s+sk-[\w-]+/i.test(hdr || "");
const isKeilaniToken = (hdr) => /^Bearer\s+kln_[\w-]+/i.test(hdr || "");

function getUpstreamUrl() {
  return process.env.UPSTREAM_CHAT_URL || "https://api.openai.com/v1/chat/completions";
}

// Returns { upstreamAuthHeader, clientTokenForForward }
function resolveAuth(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const xClient = h["x-client-token"] || h["X-Client-Token"] || "";

  // If browser provided a Keilani token in Authorization, treat it as client token, not OpenAI auth.
  let clientToken = "";
  let upstreamAuth = "";

  if (isKeilaniToken(auth)) {
    clientToken = auth.replace(/^Bearer\s+/i, "");
  } else if (xClient) {
    clientToken = xClient;
  }

  // For OpenAI: use sk- from client if present; otherwise use env OPENAI_API_KEY
  if (isOpenAIStyle(auth)) {
    upstreamAuth = auth;
  } else if (process.env.OPENAI_API_KEY) {
    upstreamAuth = `Bearer ${process.env.OPENAI_API_KEY}`;
  } // else leave blank; your custom upstream may not need it.

  return { upstreamAuthHeader: upstreamAuth, clientTokenForForward: clientToken };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...cors }, body: "" };
  if (event.httpMethod === "GET")  return ok({ ok: true, service: "keilani-chat", method: "GET", time: new Date().toISOString() });
  if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return err(400, "Invalid JSON body"); }

  const { message, model = "gpt-5", temperature, stream = true } = body || {};
  if (!message || typeof message !== "string") return err(400, "Missing 'message' (string)");

  const upstreamBody = buildUpstreamBody({ message, model, temperature, stream });
  const upstreamUrl = getUpstreamUrl();
  const { upstreamAuthHeader, clientTokenForForward } = resolveAuth(event);

  // Build headers for upstream
  const headers = { "content-type": "application/json" };
  if (upstreamAuthHeader) headers.Authorization = upstreamAuthHeader;

  // If you’re calling YOUR own upstream (set UPSTREAM_CHAT_URL),
  // forward the Keilani client token so your service can authorize.
  const forwardClientHeader = process.env.UPSTREAM_CLIENT_HEADER || "X-Client-Token";
  if (process.env.UPSTREAM_CHAT_URL && clientTokenForForward) {
    headers[forwardClientHeader] = clientTokenForForward;
  }

  let resp;
  try {
    resp = await _fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(upstreamBody) });
  } catch (e) {
    return err(502, { error: "Upstream network error", detail: e?.message || String(e) });
  }

  if (!resp.ok) {
    const detail = await safeText(resp);
    return err(resp.status, { error: "Upstream error", detail });
  }

  const ctype = resp.headers.get("content-type") || "";

  if (ctype.includes("text/event-stream")) {
    const streamText = await resp.text();
    return {
      statusCode: 200,
      headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      body: streamText,
    };
  }

  if (ctype.includes("application/json")) {
    const json = await resp.json();
    return ok(json);
  }

  const text = await resp.text();
  return { statusCode: 200, headers: { ...cors, "content-type": ctype || "text/plain; charset=utf-8" }, body: text };
};

async function safeText(r) { try { return await r.text(); } catch { return "<unreadable upstream body>"; } }
