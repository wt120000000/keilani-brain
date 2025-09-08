// stream-test.mjs
const res = await fetch("https://api.keilani.ai/api/chat-stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Stream the word pong once." }),
});

if (!res.ok || !res.body) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  // SSE frames split by double newline
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const frame = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 2);

    // Print each SSE frame
    console.log(frame);
    if (frame.startsWith("data:")) {
      const payload = frame.slice(5).trim();
      if (payload === "[DONE]") {
        console.log("✓ Stream complete");
      }
    }
  }
}
