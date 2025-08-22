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
    events: {
      transcript: "transcript",
      userStartTalking: "vad-start",
      connected: "connected",
      error: "error"
    },
    isFinalTranscript(evt) {
      return evt?.isFinal === true
          || evt?.final === true
          || evt?.type === "transcript-final"
          || evt?.segment?.is_final === true;
    },
    getTranscriptText(evt) {
      return (evt?.text || evt?.transcript || evt?.segment?.text || "").trim();
    },
    async speak(session, text) {
      return session.speak({ text });
    },
    async stopSpeaking(session) {
      if (typeof session.stopSpeaking === "function") {
        try { await session.stopSpeaking(); } catch {}
      }
      if (typeof session.cancel === "function") {
        try { await session.cancel(); } catch {}
      }
    },
    onStatus: (s) => {},
    onReply: (text, matches) => {},
    onError: (err) => { console.error("[brain-bridge]", err); },
    fetchTimeoutMs: 20000
  };

  function withTimeout(promise, ms, label="timeout") {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  function initBrainBridge(session, options = {}) {
    const cfg = { ...DEFAULTS, ...options, events: { ...DEFAULTS.events, ...(options.events || {}) } };
    let inFlight = null;
    let speaking = false;

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

    async function onUserStartTalking() {
      if (speaking) {
        try { await cfg.stopSpeaking(session); } catch {}
        speaking = false;
      }
      if (inFlight?.abort) inFlight.abort();
      inFlight = null;
      setStatus("listening…");
    }

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

  global.initBrainBridge = initBrainBridge;
})(window);
