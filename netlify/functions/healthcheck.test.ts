/**
 * Tests for healthcheck function
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandlerEvent, HandlerContext } from "@netlify/functions";
import { handler } from "./healthcheck.js";

// Mock environment
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

describe("healthcheck function", () => {
  let mockEvent: HandlerEvent;
  let mockContext: HandlerContext;

  beforeEach(() => {
    mockEvent = {
      httpMethod: "GET",
      path: "/api/healthcheck",
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
      functionName: "healthcheck",
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

    // Mock process.uptime
    vi.spyOn(process, "uptime").mockReturnValue(123.45);
  });

  it("should return 200 with health data for GET request", async () => {
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
        status: "ok",
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        commit: null,
        environment: "test",
        uptime: 123.45,
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

  it("should include commit hash when available", async () => {
    process.env.COMMIT_REF = "abc123def456";

    const result = await handler(mockEvent, mockContext);
    const body = JSON.parse(result.body);

    expect(body.data.commit).toBe("abc123def456");

    delete process.env.COMMIT_REF;
  });

  it("should use GITHUB_SHA as fallback for commit", async () => {
    process.env.GITHUB_SHA = "github-sha-123";

    const result = await handler(mockEvent, mockContext);
    const body = JSON.parse(result.body);

    expect(body.data.commit).toBe("github-sha-123");

    delete process.env.GITHUB_SHA;
  });
});