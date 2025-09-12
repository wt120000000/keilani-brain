// netlify/functions/chat-stream.js
// POST { message, system?, history?, model? } -> SSE stream of partial text
// Client should connect with fetch() and read the body as a ReadableStream.
// Each chunk is sent as "data: {json}\n\n" where json = { type, delta?, done? }

exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "Method Not Allowed",
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "Missing OPENAI_API_KEY",
    };
  }

  try {
    const input = JSON.parse(event.body || "{}");
    const {
      message,
      system,
      history = [],
      model = "gpt-4o-mini",
      max_tokens = 220,
    } = input;

    if (!message || typeof message !== "string") {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: "Missing 'message' (string)",
      };
    }

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    if (Array.isArray(history)) {
      for (const m of history) {
        if (
          m &&
          typeof m.content === "string" &&
          ["system", "user", "assistant"].includes(m.role)
        ) {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }
    messages.push({ role: "user", content: message });

    // Ask OpenAI for a streaming response
    const oaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens,
        stream: true,
      }),
    });

    if (!oaiRes.ok || !oaiRes.body) {
      const txt = await oaiRes.text();
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: `OpenAI stream error: ${txt}`,
      };
    }

    // Pipe OpenAI's SSE to client SSE, normalizing to simple "delta" messages
    const encoder = new TextEncoder();
    const reader = oaiRes.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        // helpers
        const send = (obj) => {
          const line = `data: ${JSON.stringify(obj)}\n\n`;
          controller.enqueue(encoder.encode(line));
        };

        // send an open event
        send({ type: "open" });

        let doneFlag = false;
        let buffer = "";

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);

            // OpenAI sends lines separated by \n\n. Parse them:
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();

              if (data === "[DONE]") {
                doneFlag = true;
                break;
              }

              try {
                const json = JSON.parse(data);
                const delta =
                  json?.choices?.[0]?.delta?.content ??
                  json?.choices?.[0]?.delta?.reasoning_content ??
                  "";
                if (delta) send({ type: "delta", delta });
              } catch (_) {
                // ignore malformed chunk
              }
            }

            if (doneFlag) break;
          }
        } catch (e) {
          send({ type: "error", message: String(e?.message || e) });
        } finally {
          send({ type: "done" });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: `chat-stream exception: ${e.message}`,
    };
  }
};
