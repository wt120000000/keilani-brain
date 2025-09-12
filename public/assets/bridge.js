// public/assets/bridge.js
// Minimal D-ID bridge: attach a D-ID "live session" object to this page.
// Usage (from your D-ID client tab/console): window.myDidSession = <session>

(() => {
  const statusEl = document.getElementById("didStatus");
  const detachBtn = document.getElementById("didDetach");

  let session = null;
  let cleanup = null;

  function setStatus(txt) {
    if (statusEl) statusEl.textContent = txt;
  }

  // Wire transcript-like events from the D-ID session into our UI
  function attach(s) {
    if (!s || typeof s !== "object") return;
    session = s;

    const handlers = [];

    function on(event, fn) {
      if (typeof s.on === "function") {
        s.on(event, fn);
        handlers.push({ event, fn });
      } else if (typeof s.addEventListener === "function") {
        s.addEventListener(event, fn);
        handlers.push({ event, fn, remove: "removeEventListener" });
      }
    }

    on("transcript", (e) => {
      const t = e?.text || e?.detail?.text || "";
      const box = document.getElementById("transcript");
      if (t && box) box.textContent = t;
    });

    on("speech.transcript", (e) => {
      const t = e?.text || e?.detail?.text || "";
      const box = document.getElementById("transcript");
      if (t && box) box.textContent = t;
    });

    on("asr.transcript", (e) => {
      const t = e?.text || e?.detail?.text || "";
      const box = document.getElementById("transcript");
      if (t && box) box.textContent = t;
    });

    // Optional: VAD barge-in hooks — update a tiny status tag
    const rec = document.getElementById("recState");
    ["voice-activity-start", "vad-start", "voice-start"].forEach((ev) =>
      on(ev, () => { if (rec) rec.textContent = "recording…"; })
    );
    ["voice-activity-end", "vad-end", "voice-end"].forEach((ev) =>
      on(ev, () => { if (rec) rec.textContent = "idle"; })
    );

    // Expose a simple speak helper so other scripts can trigger avatar speech
    window.didBridge = {
      speak: async (text) => {
        if (!session || !text) return;
        if (typeof session.speak === "function") {
          return session.speak({ text });
        }
        if (typeof session.send === "function") {
          return session.send({ type: "speak", text });
        }
      },
    };

    cleanup = () => {
      handlers.forEach(({ event, fn, remove }) => {
        if (remove === "removeEventListener" && typeof s.removeEventListener === "function") {
          s.removeEventListener(event, fn);
        } else if (typeof s.off === "function") {
          s.off(event, fn);
        }
      });
      handlers.length = 0;
      session = null;
      setStatus("not attached");
    };

    setStatus("attached");
  }

  function detach() {
    if (cleanup) cleanup();
    cleanup = null;
  }

  // Allow manual detach from UI
  if (detachBtn) detachBtn.addEventListener("click", detach);

  // Poll for window.myDidSession set by the D-ID client tab
  const iv = setInterval(() => {
    if (session) return; // already attached
    if (window.myDidSession) {
      try { attach(window.myDidSession); }
      catch (e) { console.error("D-ID attach failed:", e); }
    }
  }, 1000);

  // Clean up on page unload
  window.addEventListener("beforeunload", () => {
    clearInterval(iv);
    detach();
  });
})();
