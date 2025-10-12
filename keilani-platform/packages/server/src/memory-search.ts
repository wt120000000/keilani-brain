import { json } from "@keilani/core";
export default async (req: Request) => {
  const { agent_id, fan_id, query, limit = 8 } = await req.json();
  // TODO: call Supabase RPC match_memories
  return json({ rows: [], meta: { agent_id, fan_id, query, limit } });
};