import type { HandlerEvent } from "@netlify/functions";
import { makeRequestContext, handleCors, json } from "../../lib/http.js";

type Probe = { ok: boolean; latency?: number; error?: string };
type ServiceStatus = { name: string; status: "ok" | "error"; latency: number; error?: string };

export const handler = async (event: HandlerEvent) => {
  const ctx = makeRequestContext(event);
  const cors = handleCors(event.httpMethod, ctx.requestId, event.headers?.origin);
  if (cors) return cors;

  const services: ServiceStatus[] = [];

  const push = (name: string, p: Probe) => {
    services.push({
      name,
      status: p.ok ? "ok" : "error",
      latency: p.latency ?? 0,
      ...(p.error ? { error: p.error } : {}),
    });
  };

  // TODO wire real probes; placeholders OK for now
  push("openai",   { ok: true, latency: 50 });
  push("supabase", { ok: true, latency: 40 });
  push("sheetdb",  { ok: true, latency: 60 });

  return json(200, { services, requestId: ctx.requestId }, ctx.requestId);
};
