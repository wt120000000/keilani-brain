#!/usr/bin/env tsx

/**
 * Environment validation script
 * Throws on missing required environment variables
 */

interface EnvConfig {
  required: string[];
  optional: string[];
  development?: string[];
}

const ENV_CONFIG: EnvConfig = {
  required: [
    "OPENAI_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE",
  ],
  optional: [
    "OPENAI_MODEL",
    "EMBED_MODEL", 
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "ADMIN_TOKEN",
    "CORS_ALLOWED_ORIGINS",
    "RATE_LIMIT_PER_MIN",
    "SHEETDB_API_URL",
    "SHEETDB_API_KEY",
  ],
  development: [
    "NETLIFY_DEV",
  ],
};

function validateEnvironment(): void {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Check required variables
  for (const key of ENV_CONFIG.required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  // Check development-specific variables
  if (process.env.NODE_ENV === "development") {
    for (const key of ENV_CONFIG.development || []) {
      if (!process.env[key]) {
        warnings.push(`Development variable missing: ${key}`);
      }
    }
  }

  // Report results
  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach(key => console.error(`  - ${key}`));
    console.error("\nCreate a .env file or set these in your deployment environment.");
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn("⚠️  Optional environment variables not set:");
    warnings.forEach(warning => console.warn(`  - ${warning}`));
  }

  console.log("✅ Environment validation passed");
  
  // Log configured services (without exposing secrets)
  const configured = ENV_CONFIG.optional.filter(key => process.env[key]);
  if (configured.length > 0) {
    console.log("🔧 Optional services configured:", configured.join(", "));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateEnvironment();
}

export { validateEnvironment };