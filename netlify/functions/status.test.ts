/**
 * Tests for status function
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandlerEvent, HandlerContext } from "@netlify/functions";
import { handler } from "./status.js";

// Mock all the lib modules
vi.mock("../../lib/env.js", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE: "test-service-role",
    OPENAI_MODEL: "gpt-4o-mini",
    EMBED_MODEL: "text-embedding-3-small",
    NODE_ENV: "test",
  }),
}));

vi.mock("../../lib/openai.js", () => ({
  getOpenAIClient: () => ({
    healthCheck: vi.fn().mockResolvedValue({ status: "ok", latency: 150 }),
  }),
}));

vi.mock("../../lib/supabase.js", () => ({
  getSupabaseManager: () => ({
    healthCheck: vi.fn().mockResolvedValue({ status: "ok", latency: 75 }),
  }),
}));

vi.mock("../../lib/sheetdb.js", () => ({
  getSheetDBClient: () => ({
    isConfigured: vi.fn().mockReturnValue(false),
    healthCheck: vi.fn().mockResolvedValue({ status: "ok", latency: 200 }),
  }),
}));

describe("status function", () => {
  let mockEvent: HandlerEvent;
  let mockContext: HandlerContext;

  beforeEach(() => {
    mockEvent = {
      httpMethod: "GET",
      path: "/api/status",
      headers: {},
      body: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      pathParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
      isBase64Encoded: false,
      multiValueHeaders: {},
    };

    mockContext = {
      callbackWaitsForEmptyEventLoop: false,
      functionName: "status",
      functionVersion: "1",
      invokedFunctionArn: "test-arn",
      memoryLimitInMB: "128",
      awsRequestId: "test-request-id",
      logGroupName: "test-log-group",
      logStreamName: "test-log-stream",
      getRemainingTimeInMillis: () => 30000,
      done: vi.fn(),
      fail: vi.fn(),
      succeed: vi.fn(),
    };
  });

  it("should return 200 with service status data", async () => {
    const result = await handler(mockEvent, mockContext);

    expect(result.statusCode).toBe(200);
    expect(result.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Request-ID": expect.stringMatching(/^req_/),
    });

    const body = JSON.parse(result.body);
    expect(body).toMatchObject({
      success: true,
      data: {
        overall: "ok",
        services: [
          {
            name: "openai",
            status: "ok",
            latency: 150,
          },
          {
            name: "supabase",
            status: "ok",
            latency: 75,
          },
          {
            name: "sheetdb",
            status: "not_configured",
          },
        ],
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
      requestId: expect.stringMatching(/^req_/),
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("should handle CORS preflight request", async () => {
    mockEvent.httpMethod = "OPTIONS";
    mockEvent.headers.origin = "https://example.com";

    const result = await handler(mockEvent, mockContext);

    expect(result.statusCode).toBe(204);
    expect(result.headers).toMatchObject({
      "Access-Control-Allow-Origin": "https://example.com",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
      "X-Request-ID": expect.stringMatching(/^req_/),
    });
    expect(result.body).toBe("");
  });
});