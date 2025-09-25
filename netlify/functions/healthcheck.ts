import type { HandlerEvent } from "@netlify/functions";
import { success, handleCors, makeRequestContext, withLogging } from "../../lib/http.js";

export const handler = async (event: HandlerEvent) => {
  const ctx = makeRequestContext(event);

  // CORS
  const cors = handleCors(event.httpMethod, ctx.requestId, event.headers?.origin);
  if (cors) return cors;

  return withLogging(ctx, async () => {
    const commit = process.env.VERCEL_GIT_COMMIT_SHA
      ?? process.env.RENDER_GIT_COMMIT
      ?? process.env.GITHUB_SHA
      ?? "unknown";

    const body = {
      status: "ok",
      time: new Date().toISOString(),
      commit,
      uptime: process.uptime(),
      requestId: ctx.requestId,
    };

    return success(body, ctx.requestId);
  });
};
