/**
 * Health check endpoint
 * Returns basic service status and build information
 */

import type { HandlerEvent, HandlerContext } from "@netlify/functions";
import { success, handleCors, createRequestContext, withLogging } from "../../lib/http.js";

interface HealthCheckResponse {
  status: "ok";
  time: string;
  commit: string | null;
  environment: string;
  uptime: number;
}

export const handler = async (event: HandlerEvent, context: HandlerContext) => {
  const requestContext = createRequestContext(event.path, event.httpMethod);
  
  // Handle CORS preflight
  const corsResponse = handleCors(event.httpMethod, requestContext.requestId, event.headers.origin);
  if (corsResponse) {
    return corsResponse;
  }

  return withLogging(requestContext, async () => {
    const healthData: HealthCheckResponse = {
      status: "ok",
      time: new Date().toISOString(),
      commit: process.env.COMMIT_REF || process.env.GITHUB_SHA || null,
      environment: process.env.NODE_ENV || "production",
      uptime: process.uptime(),
    };

    return success(healthData, requestContext.requestId);
  })();
};