/**
 * OpenAI client with retry and timeout logic
 */

import { getEnv } from "./env.js";
import { createLogger } from "./logger.js";

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  timeout?: number;
  maxRetries?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIClient {
  private config: OpenAIConfig;
  private logger = createLogger({ service: "openai" });

  constructor(config?: Partial<OpenAIConfig>) {
    const env = getEnv();
    this.config = {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      timeout: 30000,
      maxRetries: 3,
      ...config,
    };
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number = this.config.timeout || 30000
  ): Promise<Response> {
    const controller = new AbortController();
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
      throw error;
    }
  }

  private async retryRequest<T>(
    operation: () => Promise<T>,
    maxRetries: number = this.config.maxRetries || 3
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === maxRetries) {
          break;
        }

        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        this.logger.warn(`OpenAI request failed, retrying in ${delay}ms`, {
          attempt,
          error: lastError.message,
        });
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  async chatCompletion(
    messages: ChatMessage[],
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    } = {}
  ): Promise<ChatCompletionResponse> {
    return this.retryRequest(async () => {
      const response = await this.fetchWithTimeout(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: options.model || this.config.model,
            messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
      }

      return response.json();
    });
  }

  async createEmbedding(
    input: string | string[],
    model?: string
  ): Promise<EmbeddingResponse> {
    const env = getEnv();
    
    return this.retryRequest(async () => {
      const response = await this.fetchWithTimeout(
        "https://api.openai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model || env.EMBED_MODEL,
            input,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
      }

      return response.json();
    });
  }

  async healthCheck(): Promise<{ status: "ok" | "error"; latency?: number }> {
    const startTime = Date.now();
    
    try {
      await this.chatCompletion([
        { role: "user", content: "Say 'OK' if you can hear me." }
      ], { maxTokens: 10 });
      
      const latency = Date.now() - startTime;
      return { status: "ok", latency };
    } catch (error) {
      this.logger.error("OpenAI health check failed", error);
      return { status: "error" };
    }
  }
}

let clientInstance: OpenAIClient | null = null;

export function getOpenAIClient(): OpenAIClient {
  if (!clientInstance) {
    clientInstance = new OpenAIClient();
  }
  return clientInstance;
}