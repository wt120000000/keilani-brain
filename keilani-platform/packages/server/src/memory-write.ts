import { json } from "@keilani/core";
export default async (req: Request) => {
  const { agent_id, fan_id, label, text, importance = 1, tags = [] } = await req.json();
  // TODO: embed text, insert into Supabase.memories
  return json({ ok: true, label, length: text?.length ?? 0, importance, tags });
};