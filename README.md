# Keilani Brain API

A robust, TypeScript-first API infrastructure for Keilani.ai, built on Netlify Functions with comprehensive observability, security, and testing.

## 🚀 Quick Start

### Local Development

1. **Clone and install dependencies:**
   ```bash
   git clone <repository-url>
   cd keilani-brain
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

3. **Validate environment and start development server:**
   ```bash
   npm run validate-env
   npm run dev
   ```

4. **Test the API:**
   ```bash
   # Health check
   curl http://localhost:8888/api/healthcheck
   
   # Service status
   curl http://localhost:8888/api/status
   ```

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | `sk-...` |
| `SUPABASE_URL` | Supabase project URL | `https://xyz.supabase.co` |
| `SUPABASE_SERVICE_ROLE` | Supabase service role key | `eyJ...` |

See `.env.example` for all available configuration options.

## 🏗️ Architecture

### Project Structure

```
keilani-brain/
├── lib/                    # Shared libraries
│   ├── auth.ts            # Authentication middleware
│   ├── env.ts             # Environment validation
│   ├── http.ts            # HTTP utilities & responses
│   ├── logger.ts          # Structured logging
│   ├── openai.ts          # OpenAI client with retry logic
│   ├── sheetdb.ts         # SheetDB API wrapper
│   └── supabase.ts        # Supabase client factory
├── netlify/functions/      # API endpoints
│   ├── healthcheck.ts     # Basic health check
│   ├── status.ts          # Service dependency status
│   └── *.test.ts          # Function tests
├── scripts/               # Build & utility scripts
│   └── validate-env.ts    # Environment validation
└── netlify.toml           # Netlify configuration
```

### Core Libraries

- **`lib/env.ts`**: Centralized environment validation using Zod
- **`lib/http.ts`**: Standardized HTTP responses with CORS and request IDs
- **`lib/logger.ts`**: Structured JSON logging with request correlation
- **`lib/openai.ts`**: OpenAI client with automatic retries and timeouts
- **`lib/supabase.ts`**: Supabase client factory with health checks
- **`lib/auth.ts`**: Bearer token authentication for admin endpoints

## 🔧 Development

### Available Scripts

```bash
npm run dev          # Start Netlify dev server
npm run build        # Type check and validate environment
npm run typecheck    # Run TypeScript compiler
npm run test         # Run test suite
npm run test:watch   # Run tests in watch mode
npm run lint         # Lint code
npm run lint:fix     # Fix linting issues
npm run format       # Format code with Prettier
npm run validate-env # Validate environment variables
```

### Adding a New Function

1. **Create the function file:**
   ```typescript
   // netlify/functions/my-endpoint.ts
   import type { HandlerEvent, HandlerContext } from "@netlify/functions";
   import { success, handleCors, createRequestContext, withLogging } from "../../lib/http.js";

   export const handler = async (event: HandlerEvent, context: HandlerContext) => {
     const requestContext = createRequestContext(event.path, event.httpMethod);
     
     const corsResponse = handleCors(event.httpMethod, requestContext.requestId, event.headers.origin);
     if (corsResponse) return corsResponse;

     return withLogging(requestContext, async () => {
       // Your logic here
       return success({ message: "Hello World" }, requestContext.requestId);
     })();
   };
   ```

2. **Add route to `netlify.toml`:**
   ```toml
   [[redirects]]
     from = "/api/my-endpoint"
     to = "/.netlify/functions/my-endpoint"
     status = 200
   ```

3. **Write tests:**
   ```typescript
   // netlify/functions/my-endpoint.test.ts
   import { describe, it, expect } from "vitest";
   import { handler } from "./my-endpoint.js";
   
   describe("my-endpoint", () => {
     it("should return success response", async () => {
       // Test implementation
     });
   });
   ```

### Security

- **Admin Authentication**: Set `ADMIN_TOKEN` environment variable to protect admin endpoints
- **CORS**: Configured in `netlify.toml` and handled by `lib/http.ts`
- **Request IDs**: All responses include `X-Request-ID` header for log correlation
- **Input Validation**: Use Zod schemas for request validation

### Observability

- **Structured Logging**: JSON logs with request correlation via `lib/logger.ts`
- **Health Checks**: `/api/healthcheck` for basic status, `/api/status` for detailed service health
- **Request Tracking**: Every request gets a unique ID for tracing
- **Error Handling**: Centralized error responses with proper HTTP status codes

## 🚀 Deployment

### Netlify Deployment

1. **Connect repository to Netlify**
2. **Set environment variables in Netlify dashboard**
3. **Deploy:**
   ```bash
   npm run deploy
   ```

### Environment Setup

Set these in your Netlify site settings:

```bash
OPENAI_API_KEY=sk-your-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE=your-service-role-key
# ... other variables from .env.example
```

### DNS Configuration for api.keilani.ai

1. **In Netlify Dashboard:**
   - Go to Site Settings → Domain Management
   - Add custom domain: `api.keilani.ai`
   - Follow DNS configuration instructions

2. **DNS Records (with your DNS provider):**
   ```
   Type: CNAME
   Name: api
   Value: your-site-name.netlify.app
   ```

3. **SSL Certificate:**
   - Netlify automatically provisions SSL certificates
   - Verify HTTPS works: `https://api.keilani.ai/api/healthcheck`

### Verification

After deployment, verify these endpoints work:

```bash
# Health check
curl https://api.keilani.ai/api/healthcheck

# Service status  
curl https://api.keilani.ai/api/status

# Both should also work via the Netlify function URLs:
curl https://your-site.netlify.app/.netlify/functions/healthcheck
curl https://your-site.netlify.app/.netlify/functions/status
```

## 🧪 Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm test -- --coverage
```

### Test Structure

- Unit tests for each function in `netlify/functions/*.test.ts`
- Shared library tests in `lib/*.test.ts` (when needed)
- Mocked external dependencies for reliable testing
- Coverage reporting with v8

## 📝 API Documentation

### Core Endpoints

#### `GET /api/healthcheck`
Basic health check endpoint.

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "time": "2024-01-15T10:30:00.000Z",
    "commit": "abc123",
    "environment": "production",
    "uptime": 123.45
  },
  "requestId": "req_1234567890_abc123",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

#### `GET /api/status`
Detailed service dependency status.

**Response:**
```json
{
  "success": true,
  "data": {
    "overall": "ok",
    "services": [
      {
        "name": "openai",
        "status": "ok",
        "latency": 150
      },
      {
        "name": "supabase", 
        "status": "ok",
        "latency": 75
      },
      {
        "name": "sheetdb",
        "status": "not_configured"
      }
    ],
    "timestamp": "2024-01-15T10:30:00.000Z"
  },
  "requestId": "req_1234567890_def456",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Response Format

All API responses follow this structure:

```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  requestId: string;
  timestamp: string;
}
```

### Error Handling

- `400`: Bad Request - Invalid input
- `401`: Unauthorized - Missing/invalid auth token
- `404`: Not Found - Endpoint doesn't exist
- `500`: Internal Server Error - Server-side error

All errors include a `requestId` for debugging.

## 🤝 Contributing

1. **Fork the repository**
2. **Create a feature branch:** `git checkout -b feat/my-feature`
3. **Make changes and add tests**
4. **Ensure all checks pass:**
   ```bash
   npm run typecheck
   npm test
   npm run lint
   ```
5. **Commit and push:** `git commit -m "feat: add my feature"`
6. **Open a Pull Request**

### Code Standards

- **TypeScript**: Strict mode enabled
- **ESLint**: Enforced code quality rules
- **Prettier**: Consistent code formatting
- **Testing**: Unit tests required for new functions
- **Logging**: Use structured logging via `lib/logger.ts`

## 📄 License

MIT License - see LICENSE file for details.