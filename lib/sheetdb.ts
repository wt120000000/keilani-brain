/**
 * SheetDB API client wrapper
 */

import { getEnv } from "./env.js";
import { createLogger } from "./logger.js";

export interface SheetDBConfig {
  apiUrl?: string;
  apiKey?: string;
  timeout?: number;
}

export interface SheetDBResponse<T = unknown> {
  data?: T;
  error?: string;
  status: number;
}

export class SheetDBClient {
  private config: SheetDBConfig;
  private logger = createLogger({ service: "sheetdb" });

  constructor(config?: SheetDBConfig) {
    const env = getEnv();
    this.config = {
      apiUrl: env.SHEETDB_API_URL,
      apiKey: env.SHEETDB_API_KEY,
      timeout: 10000,
      ...config,
    };
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = this.config.timeout || 10000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    };

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`SheetDB request timeout after ${timeout}ms`);
      }
      throw error;
    }
  }

  async get<T = unknown>(endpoint: string = ""): Promise<SheetDBResponse<T>> {
    if (!this.config.apiUrl) {
      return { status: 500, error: "SheetDB API URL not configured" };
    }

    try {
      const url = `${this.config.apiUrl}${endpoint}`;
      const response = await this.fetchWithTimeout(url, { method: "GET" });
      
      const data = await response.json();
      
      return {
        status: response.status,
        data: response.ok ? data : undefined,
        error: response.ok ? undefined : data.message || "SheetDB request failed",
      };
    } catch (error) {
      this.logger.error("SheetDB GET request failed", error);
      return {
        status: 500,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async post<T = unknown>(
    data: Record<string, unknown>,
    endpoint: string = ""
  ): Promise<SheetDBResponse<T>> {
    if (!this.config.apiUrl) {
      return { status: 500, error: "SheetDB API URL not configured" };
    }

    try {
      const url = `${this.config.apiUrl}${endpoint}`;
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        body: JSON.stringify(data),
      });
      
      const responseData = await response.json();
      
      return {
        status: response.status,
        data: response.ok ? responseData : undefined,
        error: response.ok ? undefined : responseData.message || "SheetDB request failed",
      };
    } catch (error) {
      this.logger.error("SheetDB POST request failed", error);
      return {
        status: 500,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async healthCheck(): Promise<{ status: "ok" | "error"; latency?: number }> {
    if (!this.config.apiUrl) {
      return { status: "error" };
    }

    const startTime = Date.now();
    
    try {
      const response = await this.get();
      const latency = Date.now() - startTime;
      
      return response.status < 400 
        ? { status: "ok", latency }
        : { status: "error" };
    } catch (error) {
      this.logger.error("SheetDB health check failed", error);
      return { status: "error" };
    }
  }

  isConfigured(): boolean {
    return !!(this.config.apiUrl && this.config.apiKey);
  }
}

let clientInstance: SheetDBClient | null = null;

export function getSheetDBClient(): SheetDBClient {
  if (!clientInstance) {
    clientInstance = new SheetDBClient();
  }
  return clientInstance;
}