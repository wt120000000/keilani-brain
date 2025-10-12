// public/sdk/boot.js
(async function () {
  function show(msg) {
    const out = document.querySelector("#kw_out");
    if (out) out.textContent = msg;
  }

  if (!window.Keilani) return show("(sdk not loaded)");

  const opts = {
    mount: "#keilani-widget",
    agent: "keilani",
    apiBase: "", // absolute to site root
    theme: { brand: "#00ffcc" },
  };

  // Wrap send to print server errors
  const origCreate = window.Keilani.createWidget;
  window.Keilani.createWidget = function (o) {
    const client = origCreate({ ...opts, ...o });
    // patch global fetch usage used by latest.js
    const _fetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await _fetch(...args);
      if (!res.ok) {
        let detail = "";
        try { detail = await res.text(); } catch {}
        console.error("chat-stream failed:", res.status, detail);
        show(`(error ${res.status}${detail ? `: ${detail}` : ""})`);
      }
      return res;
    };
    return client;
  };

  // mount
  window.Keilani.createWidget(opts);
})();
