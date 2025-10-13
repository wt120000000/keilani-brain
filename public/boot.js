// public/boot.js
(function () {
  window.Keilani = window.Keilani || {};

  function createWidget(opts) {
    const rootSel = typeof opts.mount === "string" ? document.querySelector(opts.mount) : opts.mount;
    if (!rootSel) throw new Error("mount not found");

    rootSel.innerHTML =
      '<div style="border:1px solid #333;border-radius:12px;padding:12px;font:14px system-ui;background:#0b0b0b;color:#eaeaea">' +
      '  <div style="display:flex;gap:8px">' +
      '    <input id="kw_msg" placeholder="Say hi..." style="flex:1;padding:10px;border-radius:8px;border:1px solid #222;color:#fff"/>' +
      '    <button id="kw_send" style="padding:10px 14px;border-radius:8px;background:#00ffc6;color:#000">Send</button>' +
      '  </div>' +
      '  <pre id="kw_out" style="margin-top:12px;white-space:pre-wrap;min-height:80px"></pre>' +
      '</div>';

    const out  = rootSel.querySelector("#kw_out");
    const send = rootSel.querySelector("#kw_send");
    const inp  = rootSel.querySelector("#kw_msg");
    const base = opts.apiBase || location.origin;

    async function sendMsg() {
      const text = (inp.value || "").trim();
      if (!text) return;

      out.textContent = "[stream]\n";
      // POST JSON → expect SSE back
      let res;
      try {
        res = await fetch(base + "/api/chat-stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, userId: "web", agent: opts.agent || "keilani" })
        });
      } catch (e) {
        out.textContent += `(network error: ${e})\n`;
        return;
      }

      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        out.textContent += `(http ${res.status}) ${t}\n`;
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";

      // Read SSE stream
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        const tail   = chunks.pop();
        buffer = (tail !== undefined ? tail : "");

        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();

          try {
            const evt = JSON.parse(data);
            if (evt.type === "telemetry") {
              // first bytes → show tiny tick so we know stream is open
              out.textContent += "";
            } else if (evt.type === "delta") {
              out.textContent += evt.content || "";
            } else if (evt.type === "done") {
              out.textContent += "\n";
            }
          } catch {
            // ignore noise
          }
        }
      }
    }

    send.addEventListener("click", sendMsg);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });
  }

  window.Keilani.createWidget = createWidget;

  // auto-boot if a #widget container exists
  const auto = document.getElementById("widget");
  if (auto) createWidget({ mount: auto, agent: "keilani" });
})();
