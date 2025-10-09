// netlify/edge-functions/chat-stream.mjs
export default async (request, context) => {
  // Always forward to the function (keeps one source of truth)
  const url = new URL(request.url);
  url.pathname = "/.netlify/functions/chat";
  // Preserve method/headers/body
  const init = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow",
  };
  return fetch(url, init);
};

// Optional: path filter if you’ve bound this edge function broadly
export const config = {
  path: "/api/chat",
};
