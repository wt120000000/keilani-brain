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
      const payload = { message: input.value, userId: "anon", agent: opts.agent || "keilani" };

      const res = await fetch(apiBase + "/api/chat-stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok || !res.body) {
        out.textContent = "(error " + res.status + ")";
        return;
      }

      out.textContent = "[stream]\n";

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let gotDelta = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        // Process per-line; handle both "\n" and "\r\n"
        let lineEnd;
        while ((lineEnd = buf.search(/\r?\n/)) !== -1) {
          const line = buf.slice(0, lineEnd);
          buf = buf.slice(lineEnd + (buf[lineEnd] === "\r" && buf[lineEnd + 1] === "\n" ? 2 : 1));

          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          // Only parse JSON-looking payloads
          const looksJSON = data[0] === "{" || data[0] === "[";
          if (!looksJSON) continue;

          try {
            const evt = JSON.parse(data);
            if (evt.type === "delta" && evt.content) {
              out.textContent += evt.content;
              gotDelta = true;
            } else if (evt.type === "telemetry") {
              // optional: surface telemetry
              // out.textContent += `\n[telemetry: ${evt.memMode}/${evt.memCount}]`;
            } else if (evt.type === "done") {
              out.textContent += "\n[done]";
            } else if (evt.error) {
              out.textContent += `\n(error: ${evt.error})`;
            }
            if (opts.onEvent) opts.onEvent(evt);
          } catch {
            // ignore non-JSON
          }
        }
      }

      if (!gotDelta) out.textContent += "\n[no content received]";
    }

    send.onclick = sendMsg;
    input.addEventListener("keydown", (e) => e.key === "Enter" && sendMsg());
  }

  window.Keilani = { createWidget };
})();
