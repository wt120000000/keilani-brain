// netlify/edge-functions/chat-stream.mjs
/**
 * Edge proxy for streamed chat.
 * Forwards requests to the stream-chat function while preserving CORS and SSE behavior.
 */

export default async (request, context) => {
  const target = new URL(request.url);
  target.pathname = "/.netlify/functions/stream-chat";

  return fetch(target.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  });
};

export const config = {
  path: "/api/chat-stream",
};
