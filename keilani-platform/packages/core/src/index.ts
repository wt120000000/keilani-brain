export type Agent = {
  id: string;
  handle: string;
  display_name: string;
  system_prompt: string;
  public_config?: Record<string, unknown>;
};
export type Fan = { id: string; username?: string | null };

export type ChatRequest = { agent: string; fanToken?: string; message: string; };

export type ChatChunk =
  | { type: "telemetry"; memCount: number; memMode: string; timestamp: string }
  | { type: "delta"; content: string }
  | { type: "done" };

export const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" }, ...init });

export const sseChunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;