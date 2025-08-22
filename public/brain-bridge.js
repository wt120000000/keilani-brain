// public/brain-bridge.js
/**
 * Keilani Brain Bridge for D-ID
 * - Normalizes transcript events
 * - Sends final text to /api/chat
 * - Speaks reply with your D-ID session
 */

(function (global) {
  const DEFAULTS = {
    chatUrl: "/api/chat?threshold=0.6&count=8",
    userId: "00000000-0000-0000-0000-000000000001",
    // event names (customize to your D-ID SDK flavor)
    events: {
      transcript: "transcript",          // fired frequently with partials/finals
      userStartTalking: "vad-start",     // or 'voice-activity-start'
      connected: "connected",            // optional: session ready
      error: "error"                     // optional: SDK error
    },
    // How to detect "final" transcript. Adjust to your SDK’s payload.
    isFinalTranscript(evt) {
      return evt?.isFinal === true
          || evt?.final === true
          || evt?.type === "transcript-final"
          || evt?.segment?.is_final === true;
    },
    // How to read text from the event
    getTranscriptText(evt) {
      return (evt?.text || evt?.transcript || evt?.segment?.text || "").trim();
    },
    // How to speak with your session
    async speak(session, text) {
      // Replace with your real SDK call if different:
      return session.speak({ text });
    },
    // How to stop speaking (barge-in)
    async stopSpeaking(session) {
      if (typeof session.stopSpeaking === "function") {
        try { await session.stopSpeaking(); } catch {}
      }
      if (typeof session.cancel === "function") {
        try { await session.cancel(); } catch {}
      }
    },
    // Optional hooks/UI
    onStatus: (s) => { /* e.g., document.getElementById('status').textContent = s; */ },
    onReply: (text, matches) => { /* update UI */ },
    onError: (err) => { console.error("[brain-bridge]", err); },
    // Network
    fetchTimeoutMs: 20000
  };

  function withTimeout(promise, ms, label="timeout") {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  function initBrainBridge(session, options = {}) {
    const cfg = { ...DEFAULTS, ...options, events: { ...DEFAULTS.events, ...(options.events || {}) } };
    let inFlight = null;       // AbortController for brain call
    let speaking = false;      // track if avatar is speaking

    function setStatus(s){ try { cfg.onStatus(s); } catch {} }

    async function handleFinalTranscript(text) {
      if (!text) return;
      if (inFlight?.abort) inFlight.abort();

      const ctrl = new AbortController();
      inFlight = ctrl;

      setStatus("thinking…");

      try {
        const resp = await withTimeout(fetch(cfg.chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ userId: cfg.userId, message: text })
        }), cfg.fetchTimeoutMs, "brain call timed out");

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `brain ${resp.status}`);

        const reply = (data.reply || "Got it.").trim();
        speaking = true;
        await cfg.speak(session, reply);
        speaking = false;

        try { cfg.onReply(reply, data.matches || []); } catch {}
        setStatus("idle");
      } catch (e) {
        setStatus("idle");
        try { cfg.onError(e); } catch {}
        try {
          speaking = true;
          await cfg.speak(session, "Sorry, I glitched. Can you repeat that?");
          speaking = false;
        } catch {}
      } finally {
        inFlight = null;
      }
    }

    // Barge-in: user starts talking → stop speech and abort brain
    async function onUserStartTalking() {
      if (speaking) {
        try { await cfg.stopSpeaking(session); } catch {}
        speaking = false;
      }
      if (inFlight?.abort) inFlight.abort();
      inFlight = null;
      setStatus("listening…");
    }

    // Transcript handler
    async function onTranscript(evt) {
      try {
        if (!cfg.isFinalTranscript(evt)) return;
        const text = cfg.getTranscriptText(evt);
        if (!text) return;
        await handleFinalTranscript(text);
      } catch (e) {
        cfg.onError(e);
      }
    }

    // Wire events (adjust to your SDK’s event API)
    if (typeof session.on === "function") {
      session.on(cfg.events.transcript, onTranscript);
      if (cfg.events.userStartTalking) session.on(cfg.events.userStartTalking, onUserStartTalking);
      if (cfg.events.connected)       session.on(cfg.events.connected, () => setStatus("connected"));
      if (cfg.events.error)           session.on(cfg.events.error, (e) => cfg.onError(e));
    }

    if (typeof session.addEventListener === "function") {
      session.addEventListener(cfg.events.transcript, onTranscript);
      if (cfg.events.userStartTalking) session.addEventListener(cfg.events.userStartTalking, onUserStartTalking);
      if (cfg.events.connected)        session.addEventListener(cfg.events.connected, () => setStatus("connected"));
      if (cfg.events.error)            session.addEventListener(cfg.events.error, (e) => cfg.onError(e));
    }

    setStatus("ready");
    return { onTranscript, onUserStartTalking };
  }

  // expose
  global.initBrainBridge = initBrainBridge;
})(window);
