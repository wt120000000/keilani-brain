/**
 * API authentication middleware
 */

import type { HandlerEvent } from "@netlify/functions";
import { getEnv } from "./env.js";
import { unauthorized } from "./http.js";

export function requireAdminAuth(event: HandlerEvent, requestId: string) {
  const env = getEnv();
  
  if (!env.ADMIN_TOKEN) {
    // If no admin token is configured, allow all requests
    return null;
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  
  if (!authHeader) {
    return unauthorized("Authorization header required", requestId);
  }

  const token = authHeader.replace(/^Bearer\s+/i, "");
  
  if (token !== env.ADMIN_TOKEN) {
    return unauthorized("Invalid authorization token", requestId);
  }

  return null; // Auth passed
}

export function getBearerToken(authHeader?: string): string | null {
  const match = authHeader?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function extractBearerToken(event: HandlerEvent): string | null {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  return getBearerToken(authHeader);
}