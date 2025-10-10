// netlify/edge-functions/chat-stream.mjs
/**
 * Simple edge proxy to the serverless streamer.
 * (No OpenAI SDK here, so we avoid token/SDK drift and bundling issues.)
 *
 * If you later stream directly from OpenAI at the edge, remember:
 *  - For Chat Completions: use `max_tokens` (NOT max_output_tokens)
 *  - For Responses API: `max_output_tokens` is correct
 */

export default async (request, context) => {
  // Forward the exact request to the serverless streaming function
  const inUrl = new URL(request.url);
  inUrl.pathname = "/.netlify/functions/stream-chat";

  return await fetch(inUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  });
};

export const config = {
  path: "/api/chat-stream",
};
