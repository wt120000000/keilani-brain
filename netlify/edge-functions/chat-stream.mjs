export default async (request) => {
  const url = new URL(request.url);
  url.pathname = "/.netlify/functions/chat";
  return fetch(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow",
  });
};

export const config = { path: "/api/chat" };
