/**
 * Service status endpoint
 * Returns detailed status of all external dependencies
 */

import type { HandlerEvent, HandlerContext } from "@netlify/functions";
import { success, handleCors, createRequestContext, withLogging } from "../../lib/http.js";
import { getOpenAIClient } from "../../lib/openai.js";
import { getSupabaseManager } from "../../lib/supabase.js";
import { getSheetDBClient } from "../../lib/sheetdb.js";
import { createLogger } from "../../lib/logger.js";

interface ServiceStatus {
  name: string;
  status: "ok" | "error" | "not_configured";
  latency?: number;
  error?: string;
}

interface StatusResponse {
  overall: "ok" | "degraded" | "error";
  services: ServiceStatus[];
  timestamp: string;
}

export const handler = async (event: HandlerEvent, context: HandlerContext) => {
  const requestContext = createRequestContext(event.path, event.httpMethod);
  const logger = createLogger(requestContext);
  
  // Handle CORS preflight
  const corsResponse = handleCors(event.httpMethod, requestContext.requestId, event.headers.origin);
  if (corsResponse) {
    return corsResponse;
  }

  return withLogging(requestContext, async () => {
    const services: ServiceStatus[] = [];

    // Check OpenAI
    try {
      logger.debug("Checking OpenAI status");
      const openaiClient = getOpenAIClient();
      const openaiHealth = await openaiClient.healthCheck();
      services.push({
        name: "openai",
        status: openaiHealth.status,
        latency: openaiHealth.latency,
      });
    } catch (error) {
      logger.error("OpenAI status check failed", error);
      services.push({
        name: "openai",
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    // Check Supabase
    try {
      logger.debug("Checking Supabase status");
      const supabaseManager = getSupabaseManager();
      const supabaseHealth = await supabaseManager.healthCheck();
      services.push({
        name: "supabase",
        status: supabaseHealth.status,
        latency: supabaseHealth.latency,
      });
    } catch (error) {
      logger.error("Supabase status check failed", error);
      services.push({
        name: "supabase",
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    // Check SheetDB (optional)
    try {
      logger.debug("Checking SheetDB status");
      const sheetdbClient = getSheetDBClient();
      
      if (!sheetdbClient.isConfigured()) {
        services.push({
          name: "sheetdb",
          status: "not_configured",
        });
      } else {
        const sheetdbHealth = await sheetdbClient.healthCheck();
        services.push({
          name: "sheetdb",
          status: sheetdbHealth.status,
          latency: sheetdbHealth.latency,
        });
      }
    } catch (error) {
      logger.error("SheetDB status check failed", error);
      services.push({
        name: "sheetdb",
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    // Determine overall status
    const errorCount = services.filter(s => s.status === "error").length;
    const okCount = services.filter(s => s.status === "ok").length;
    
    let overall: "ok" | "degraded" | "error";
    if (errorCount === 0) {
      overall = "ok";
    } else if (okCount > 0) {
      overall = "degraded";
    } else {
      overall = "error";
    }

    const statusData: StatusResponse = {
      overall,
      services,
      timestamp: new Date().toISOString(),
    };

    logger.info("Status check completed", { 
      overall, 
      serviceCount: services.length,
      errorCount,
      okCount 
    });

    return success(statusData, requestContext.requestId);
  })();
};