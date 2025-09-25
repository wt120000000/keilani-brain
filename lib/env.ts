/**
 * Environment configuration and validation
 */

import { z } from "zod";

const envSchema = z.object({
  // Required
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE: z.string().min(1, "SUPABASE_SERVICE_ROLE is required"),
  
  // Optional with defaults
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  EMBED_MODEL: z.string().default("text-embedding-3-small"),
  RATE_LIMIT_PER_MIN: z.string().transform(Number).default("15"),
  
  // Optional
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  ADMIN_TOKEN: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  SHEETDB_API_URL: z.string().url().optional(),
  SHEETDB_API_KEY: z.string().optional(),
  
  // Runtime
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  NETLIFY_DEV: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;
export let env: Env;

export function getEnv(): Env {
  if (cachedEnv) {
    env = cachedEnv;
    return cachedEnv;
  }

  try {
    cachedEnv = envSchema.parse(process.env);
    env = cachedEnv;
    return cachedEnv;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Environment validation failed:");
      error.errors.forEach(err => {
        console.error(`  - ${err.path.join(".")}: ${err.message}`);
      });
    }
    throw new Error("Environment validation failed");
  }
}

export function isDevelopment(): boolean {
  return getEnv().NODE_ENV === "development" || !!getEnv().NETLIFY_DEV;
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === "production";
}