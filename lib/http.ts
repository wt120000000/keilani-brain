/**
 * HTTP utilities for Netlify Functions
 */

import type { HandlerResponse } from "@netlify/functions";
import { generateRequestId, createLogger, type LogContext } from "./logger.js";

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  requestId: string;
  timestamp: string;
}

export interface RequestContext extends LogContext {
  requestId: string;
  startTime: number;
  path: string;
  method: string;
}

export function makeRequestContext(event: HandlerEvent): RequestContext {
  return {
    requestId: crypto.randomUUID(),
    startTime: Date.now(),
    path: event.path ?? "",
    method: event.httpMethod ?? "",
  };
}

export function json<T>(
  statusCode: number,
  data: T,
  requestId: string,
  headers: Record<string, string> = {}
): HandlerResponse {
  const response: ApiResponse<T> = {
    success: statusCode >= 200 && statusCode < 300,
    data,
    requestId,
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
      ...headers,
    },
    body: JSON.stringify(response),
  };
}

export function success<T>(data: T, requestId: string, headers?: Record<string, string>): HandlerResponse {
  return json(200, data, requestId, headers);
}

export function badRequest(message: string, requestId: string): HandlerResponse {
  const response: ApiResponse = {
    success: false,
    error: message,
    requestId,
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode: 400,
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify(response),
  };
}

export function unauthorized(message: string, requestId: string): HandlerResponse {
  const response: ApiResponse = {
    success: false,
    error: message,
    requestId,
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode: 401,
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify(response),
  };
}

export function notFound(message: string, requestId: string): HandlerResponse {
  const response: ApiResponse = {
    success: false,
    error: message,
    requestId,
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode: 404,
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify(response),
  };
}

export function internalError(message: string, requestId: string): HandlerResponse {
  const response: ApiResponse = {
    success: false,
    error: message,
    requestId,
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode: 500,
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify(response),
  };
}

export function corsHeaders(origin?: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
    "Access-Control-Max-Age": "86400",
  };
}

export function handleCors(method: string, requestId: string, origin?: string): HandlerResponse | null {
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        ...corsHeaders(origin),
        "X-Request-ID": requestId,
      },
      body: "",
    };
  }
  return null;
}

export function withLogging<T extends Record<string, unknown>>(
  context: RequestContext,
  handler: () => Promise<HandlerResponse>
) {
  return async (): Promise<HandlerResponse> => {
    const logger = createLogger(context);
    
    try {
      logger.info("Request started");
      const response = await handler();
      
      const duration = Date.now() - context.startTime;
      logger.info("Request completed", { 
        statusCode: response.statusCode,
        duration 
      });
      
      return response;
    } catch (error) {
      const duration = Date.now() - context.startTime;
      logger.error("Request failed", error, { duration });
      return internalError("Internal server error", context.requestId);
    }
  };
}