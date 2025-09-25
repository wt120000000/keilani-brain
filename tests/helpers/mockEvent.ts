import type { HandlerEvent } from "@netlify/functions";

export function mockEvent(partial: Partial<HandlerEvent> = {}): HandlerEvent {
  return {
    rawUrl: "http://localhost/api/test",
    rawQuery: "",
    path: "/api/test",
    httpMethod: "GET",
    headers: { origin: "https://example.com", ...(partial.headers ?? {}) },
    multiValueHeaders: {},
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    body: null,
    isBase64Encoded: false,
    ...partial,
  };
}
