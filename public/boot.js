(() => {
  // Minimal widget UI ---------------------------------------------------------
  function createWidget(opts = {}) {
    const root =
      typeof opts.mount === "string"
        ? document.querySelector(opts.mount)
        : opts.mount;

    if (!root) throw new Error("mount not found");

    root.innerHTML =
      '<div style="border:1px solid #333;border-radius:12px;padding:12px;font:14px system-ui;background:#0b0b0b;color:#eaeaea">' +
      '  <div style="display:flex;gap:8px;">' +
      '    <input id="kw_msg" placeholder="Say hi..." ' +
      '           style="flex:1;padding:10px;border-radius:8px;background:#111;border:1px solid #222;color:#fff"/>' +
      '    <button id="kw_send" style="padding:10px 14px;border-radius:8px;background:' +
      (opts.theme && opts.theme.brand ? opts.theme.brand : "#00ffc6") +
      ';color:#000">Send</button>' +
      "  </div>" +
      '  <pre id="kw_out" style="margin-top:12px;white-space:pre-wrap;min-height:80px"></pre>' +
      "</div>";

    const out = root.querySelector("#kw_out");
    const sendBtn = root.querySelector("#kw_send");
    const input = root.querySelector("#kw_msg");
    const apiBase = opts.apiBase || location.origin;

    async function send() {
      const msg = String(input.value || "").trim();
      if (!msg) return;
      input.value = "";
      out.textContent = "[stream]\n";

      try {
        const r = await fetch(`${apiBase}/api/chat-stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: msg,
            userId: opts.userId || "web",
            agent: opts.agent || "keilani",
          }),
        });

        if (!r.ok || !r.body) {
          const text = await r.text().catch(() => "(no body)");
          out.textContent += `\n(error ${r.status}: ${text})`;
          return;
        }

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by blank line
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.trim();
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trim();

            if (data === "[DONE]") {
              out.textContent += "\n";
              return;
            }

            try {
              const evt = JSON.parse(data);
              if (evt.type === "delta" && evt.content) {
                out.textContent += evt.content;
              } else if (evt.type === "telemetry") {
                // optional: out.textContent += `\n[${evt.model}] `;
              } else if (evt.type === "done") {
                out.textContent += "\n";
                return;
              }
            } catch {
              // non-JSON control lines from upstream; ignore
            }
          }
        }
      } catch (err) {
        out.textContent += `\n(network error: ${String(err)})`;
      }
    }

    // Wire events
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // expose for debugging
    window.Keilani = window.Keilani || {};
    window.Keilani.send = (m) => {
      input.value = m;
      sendBtn.click();
    };
  }

  // Auto-mount on page load ---------------------------------------------------
  window.addEventListener("DOMContentLoaded", () => {
    const mount =
      document.querySelector("#widget") ||
      (() => {
        const d = document.createElement("div");
        d.id = "widget";
        document.body.appendChild(d);
        return d;
      })();

    createWidget({
      mount,
      agent: "keilani",
      userId: "web",
      theme: { brand: "#00ffc6" },
    });
  });
})();
