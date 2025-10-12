/* Minimal browser streaming client for POST + SSE (text/event-stream) */

(() => {
  const $ = (sel) => document.querySelector(sel);
  const form = $("#chatForm");
  const input = $("#message");
  const out = $("#out");
  const btnStream = $("#btnStream");
  const btnStop = $("#btnStop");

  let controller = null; // AbortController for cancel
  let running = false;

  function write(text, cls) {
    const prefix = cls ? "" : "";
    out.insertAdjacentHTML("beforeend", `${cls ? `<span class="${cls}">` : ""}${text}${cls ? "</span>" : ""}`);
    out.scrollTop = out.scrollHeight;
  }

  function writeln(text = "", cls) {
    write(text + "\n", cls);
  }

  function setRunning(v) {
    running = v;
    btnStream.disabled = v;
    btnStop.disabled = !v;
  }

  // Very small SSE chunk parser for OpenAI-compatible server-sent events over fetch streaming.
  // We read the stream, split on \n\n event boundaries, then parse each "data: ..." line payload.
  async function streamChat({ url, body }) {
    controller = new AbortController();
    setRunning(true);
    out.textContent = ""; // clear

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        writeln(`HTTP ${res.status} ${res.statusText}`, "err");
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // helpful status line
      writeln(`Connected. Parsing stream…`, "muted");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events separated by \n\n
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          // Handle possible multi-line events; collect all 'data:' lines
          const lines = rawEvent.split("\n");
          const dataLines = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());

          const payload = dataLines.join("\n");
          if (!payload) continue;

          if (payload === "[DONE]") {
            writeln("\n[stream complete]", "ok");
            break;
          }

          // Some backends also emit telemetry, e.g. { type: "telemetry", ... }
          try {
            const json = JSON.parse(payload);

            // OpenAI chunk format:
            // { choices: [ { delta: { content: "..." }, finish_reason: null } ] }
            const choice = json.choices && json.choices[0];
            const delta = choice && choice.delta;
            if (delta && typeof delta.content === "string") {
              write(delta.content); // append token(s) directly
            }

            // If your function emits non-OpenAI messages (e.g., telemetry), ignore them here
            if (json.type === "telemetry" && json.memCount != null) {
              // show a tiny one-liner but not noisy
              writeln(`\n[telemetry: mem=${json.memCount}, mode=${json.memMode}]`, "muted");
            }
          } catch {
            // Not JSON (could be plain text). Just show it raw.
            write(payload);
          }
        }
      }

      // Flush any trailing buffer (not usually necessary for SSE, but harmless)
      if (buffer.trim()) {
        try {
          const json = JSON.parse(buffer.trim());
        const choice = json.choices && json.choices[0];
        const delta = choice && choice.delta;
        if (delta && typeof delta.content === "string") write(delta.content);
        } catch {
          write(buffer.trim());
        }
      }

      setRunning(false);
    } catch (err) {
      if (err.name === "AbortError") {
        writeln("\n[aborted]", "muted");
      } else {
        writeln(`\n${err.message || err}`, "err");
      }
      setRunning(false);
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const message = input.value.trim() || "Tell me about synthwave.";
    streamChat({
      url: "/api/chat-stream",
      body: {
        message,
        userId: "123e4567-e89b-12d3-a456-426614174000",
      },
    });
  });

  btnStop.addEventListener("click", () => {
    if (controller && running) controller.abort();
  });

  // Enable initial button states
  setRunning(false);
})();