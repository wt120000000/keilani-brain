import { json } from "@keilani/core";
export default async (req: Request) => {
  const { text } = await req.json();
  // TODO: call ElevenLabs or Web Speech fallback
  return json({ url: "data:audio/wav;base64,...", charCount: text?.length ?? 0 });
};