// Minimal boot that posts to /api/chat-stream and renders streaming delta frames into a <pre id="log">
(async function () {
  const logEl = document.getElementById("log");
  const input = document.getElementById("msg");
  const btn   = document.getElementById("send");

  function log(s){ logEl.textContent += s; }

  btn?.addEventListener("click", async () => {
    logEl.textContent = "[stream]\n";
    const res = await fetch("/api/chat-stream", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "text/event-stream" },
      body: JSON.stringify({ message: input.value || "hi", userId: "web", agent: "keilani" })
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream:true });
      const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
      for (const p of parts) {
        if (!p.startsWith("data:")) continue;
        const data = p.slice(5).trim();
        try {
          const j = JSON.parse(data);
          if (j.type === "delta") log(j.content);
        } catch {}
      }
    }
  });
})();
