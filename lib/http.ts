import type { HandlerEvent } from "@netlify/functions";

export type RequestContext = {
  requestId: string;
  startTime: number;
  path: string;
  method: string;
};

export function makeRequestContext(event: HandlerEvent): RequestContext {
  const uuid =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  const requestId = `req_${uuid}`;
  return {
    requestId,
    startTime: Date.now(),
    path: event.path ?? "",
    method: event.httpMethod ?? "",
  };
}

// --- CORS ---
export function handleCors(method: string | undefined, requestId: string, origin?: string) {
  const allowedOrigin = origin ?? "*";
  const baseHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
    "Access-Control-Max-Age": "86400",
    "X-Request-ID": requestId,
  } as const;

  if (method?.toUpperCase() === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }
  return null;
}

// --- JSON helpers ---
export function json(statusCode: number, body: unknown, requestId?: string) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...(requestId ? { "X-Request-ID": requestId } : {}),
    },
    body: JSON.stringify(body),
  };
}
export function success(body: unknown, requestId?: string) {
  return json(200, body, requestId);
}
export function badRequest(message: string, requestId?: string) {
  return json(400, { error: { code: "bad_request", message, requestId } }, requestId);
}
export function internalError(message: string, requestId?: string) {
  return json(500, { error: { code: "internal", message, requestId } }, requestId);
}
export function unauthorized(message = "Unauthorized", requestId?: string) {
  return json(401, { error: { code: "unauthorized", message, requestId } }, requestId);
}

// --- logging wrapper ---
export async function withLogging<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    const duration = Date.now() - ctx.startTime;
    console.log(JSON.stringify({
      level: "info",
      requestId: ctx.requestId,
      path: ctx.path,
      method: ctx.method,
      duration
    }));
  }
}
