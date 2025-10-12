import { json } from "@keilani/core";
export default async (req: Request) => {
  const { text } = await req.json();
  // TODO: call OpenAI moderation or rules
  return json({ allowed: true, flags: [] });
};