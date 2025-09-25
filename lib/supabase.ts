/**
 * Supabase client factory and utilities
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./env.js";
import { createLogger } from "./logger.js";

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  timeout?: number;
}

export class SupabaseManager {
  private client: SupabaseClient;
  private config: SupabaseConfig;
  private logger = createLogger({ service: "supabase" });

  constructor(config?: Partial<SupabaseConfig>) {
    const env = getEnv();
    this.config = {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE,
      timeout: 10000,
      ...config,
    };

    this.client = createClient(this.config.url, this.config.serviceRoleKey, {
      auth: {
        persistSession: false,
      },
      global: {
        fetch: this.fetchWithTimeout.bind(this),
      },
    });
  }

  private async fetchWithTimeout(
    url: RequestInfo | URL,
    options: RequestInit = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = this.config.timeout || 10000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Supabase request timeout after ${timeout}ms`);
      }
      throw error;
    }
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  async healthCheck(): Promise<{ status: "ok" | "error"; latency?: number }> {
    const startTime = Date.now();
    
    try {
      // Simple query to test connectivity
      const { error } = await this.client
        .from("kb_chunks")
        .select("id")
        .limit(1);

      if (error) {
        throw error;
      }

      const latency = Date.now() - startTime;
      return { status: "ok", latency };
    } catch (error) {
      this.logger.error("Supabase health check failed", error);
      return { status: "error" };
    }
  }

  async query<T>(
    table: string,
    operation: (query: any) => any
  ): Promise<{ data: T[] | null; error: any }> {
    try {
      const query = this.client.from(table);
      return await operation(query);
    } catch (error) {
      this.logger.error(`Supabase query failed for table: ${table}`, error);
      return { data: null, error };
    }
  }
}

let managerInstance: SupabaseManager | null = null;

export function getSupabaseManager(): SupabaseManager {
  if (!managerInstance) {
    managerInstance = new SupabaseManager();
  }
  return managerInstance;
}

export function getSupabaseClient(): SupabaseClient {
  return getSupabaseManager().getClient();
}