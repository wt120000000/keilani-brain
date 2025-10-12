import { json } from "@keilani/core";
export default async (req: Request) => {
  const evt = await req.json();
  // TODO: write to Supabase.analytics_events
  return json({ ok: true, received: evt?.name ?? "unknown" });
};