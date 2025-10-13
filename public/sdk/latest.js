// /public/sdk/latest.js
(function () {
  function createWidget(opts) {
    var root = typeof opts.mount === "string" ? document.querySelector(opts.mount) : opts.mount;
    if (!root) throw new Error("mount not found");

    root.innerHTML =
      '<div style="border:1px solid #333;border-radius:12px;padding:12px;font:14px system-ui;background:#0b0b0b;color:#eaeaea">' +
      '  <div style="display:flex;gap:8px">' +
      '    <input id="kw_msg" placeholder="Say hi..." style="flex:1;padding:10px;border-radius:8px;background:#111;border:1px solid #222;color:#fff"/>' +
      '    <button id="kw_send" style="padding:10px 14px;border-radius:8px;border:0;background:' +
      ((opts.theme && opts.theme.brand) || "#00ffcc") +
      ';color:#000">Send</button>' +
      "  </div>" +
      '  <pre id="kw_out" style="margin-top:12px;white-space:pre-wrap;min-height:80px"></pre>' +
      "</div>";

    var out = root.querySelector("#kw_out");
    var send = root.querySelector("#kw_send");
    var input = root.querySelector("#kw_msg");
    var apiBase = opts.apiBase || location.origin;

    async function sendMsg() {
      var payload = { message: input.value, userId: "anon", agent: opts.agent || "keilani" };

      const res = await fetch(apiBase + "/api/chat-stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok || !res.body) {
        out.textContent = "(error " + res.status + ")";
        return;
      }

      out.textContent = "[stream]\n";
      const reader = res.body.getReader();
      const dec = new TextDecoder();

      let buffer = "";
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        buffer += dec.decode(r.value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const packet = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          // Process each line in the packet
          for (const line of packet.split("\n")) {
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trim(); // after "data:"
            if (!data || data === "[DONE]") continue;

            // Only parse when it looks like JSON
            if (data[0] === "{" || data[0] === "[") {
              try {
                const obj = JSON.parse(data);
                if (obj.type === "delta" && obj.content) out.textContent += obj.content;
                else if (obj.type === "telemetry") {
                  // optional: show nothing; available via opts.onEvent
                } else if (obj.type === "done") {
                  out.textContent += "\n[done]";
                } else if (obj.error) {
                  out.textContent += "\n(error: " + obj.error + ")";
                }
                opts.onEvent && opts.onEvent(obj);
              } catch {
                // Not JSON after all — ignore quietly
              }
            }
          }
        }
      }
    }

    send.onclick = sendMsg;
    input.addEventListener("keydown", (e) => (e.key === "Enter" ? sendMsg() : 0));
  }

  window.Keilani = { createWidget };
})();
