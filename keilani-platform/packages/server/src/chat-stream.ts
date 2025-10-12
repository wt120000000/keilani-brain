import { OpenAI } from "openai";
import { sseChunk } from "@keilani/core";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async (req: Request) => {
  try {
    const { message, agent = "keilani", fanToken } = await req.json();
    // TODO: verify fanToken → fan_id, load agent prompt & memories
    const system = `You are ${agent}, a friendly AI influencer. Keep replies concise and positive.`;

    const stream = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL_CHAT || "gpt-4o-mini-2024-07-18",
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ],
      stream: true
    });

    const headers = new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive"
    });

    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(sseChunk({ type: "telemetry", memCount: 5, memMode: "vector", timestamp: new Date().toISOString() }));
        for await (const part of stream) {
          const delta = part.choices?.[0]?.delta?.content;
          if (delta) controller.enqueue(sseChunk({ type: "delta", content: delta }));
        }
        controller.enqueue(sseChunk({ type: "done" }));
        controller.close();
      }
    });

    return new Response(body, { headers, status: 200 });
  } catch (e: any) {
    return new Response(`data: ${JSON.stringify({ error: e?.message || "unknown" })}\n\n`, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      status: 200
    });
  }
};