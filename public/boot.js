// public/boot.js
(() => {
  const API = {
    stream: "/api/chat-stream",
    health: "/api/health",
  };

  // --- tiny helpers ---------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const now = () => new Date().toISOString();

  function ensureWidget() {
    // If the SDK already injected the widget (latest.js), use that.
    let msg = $("#kw_msg");
    let send = $("#kw_send");
    let out = $("#kw_out");

    if (msg && send && out) return { msg, send, out };

    // Otherwise create a super simple fallback widget.
    const root = document.createElement("div");
    root.style.cssText =
      "border:1px solid #333;border-radius:12px;padding:12px;margin:16px 0;color:#eee;background:#0b0b0b;font:14px system-ui;";
    root.innerHTML =
      '<div style="display:flex;gap:8px;margin-bottom:8px">' +
      '  <input id="kw_msg" placeholder="Say hi..." style="flex:1;padding:10px;border-radius:8px;border:1px solid #222;background:#111;color:#fff"/>' +
      '  <button id="kw_send" style="padding:10px 14px;border-radius:8px;border:0;background:#00ffc6;color:#000;cursor:pointer">Send</button>' +
      "</div>" +
      '<pre id="kw_out" style="margin:8px 0;white-space:pre-wrap;min-height:48px"></pre>';
    document.body.appendChild(root);

    return {
      msg: $("#kw_msg"),
      send: $("#kw_send"),
      out: $("#kw_out"),
    };
  }

  function print(out, text) {
    out.textContent += text;
  }
  function println(out, text) {
    out.textContent += text + "\n";
  }
  function reset(out) {
    out.textContent = "";
  }

  // --- streaming client -----------------------------------------------------
  async function sendMessage({ message, userId, agent }, out) {
    reset(out);
    println(out, "[stream]");

    let res;
    try {
      res = await fetch(API.stream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, userId, agent }),
      });
    } catch (err) {
      println(out, `\n(network error) ${String(err)}`);
      return;
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {}
      println(out, `\n(error ${res.status}) ${detail || res.statusText}`);
      return;
    }

    if (!res.body) {
      println(out, "\n[no content]");
      return;
    }

    // Read the SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Optional: hard timeout so we don’t hang forever
    let doneFlag = false;
    const timer = setTimeout(() => {
      if (!doneFlag) println(out, "\n[timeout]");
    }, 120000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split into SSE frames. Each frame is separated by \n\n.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || ""; // keep last partial

        for (const frame of frames) {
          // Only care about lines that start with "data:"
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;

          if (payload === "[DONE]") {
            doneFlag = true;
            clearTimeout(timer);
            println(out, "\n[done]");
            return;
          }

          try {
            const json = JSON.parse(payload);
            if (json.type === "telemetry") {
              // You can log or ignore telemetry
              // console.debug("telemetry:", json);
              continue;
            }
            if (json.type === "delta" && json.content) {
              print(out, json.content);
              continue;
            }
            if (json.type === "done") {
              doneFlag = true;
              clearTimeout(timer);
              println(out, "\n[done]");
              return;
            }
            // Unknown frame → ignore quietly
          } catch {
            // Non-JSON data → ignore
          }
        }
      }
    } catch (err) {
      println(out, `\n(stream error) ${String(err)}`);
    } finally {
      if (!doneFlag) {
        clearTimeout(timer);
        println(out, "\n[ended]");
      }
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  // --- bootstrap ------------------------------------------------------------
  window.addEventListener("DOMContentLoaded", async () => {
    const { msg, send, out } = ensureWidget();

    // Optional: quick health ping so we can spot missing env fast
    try {
      const h = await fetch(API.health, { cache: "no-store" }).then((r) => r.json());
      println(out, `[health ${now()}] ${JSON.stringify(h)}`);
      println(out, ""); // spacer
    } catch {
      // ignore
    }

    function go() {
      const text = (msg.value || "").trim();
      if (!text) return;
      sendMessage({ message: text, userId: "web", agent: "keilani" }, out);
    }

    send.addEventListener("click", go);
    msg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        go();
      }
    });
  });
})();
