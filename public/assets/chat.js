// public/assets/chat.js
// BUILD: 2025-09-20T22:10Z
// Natural cadence: only play a short filler if the backend is *actually* slow.
// Hands-free loop stays on. Subtle tone-capture for the server (last transcript).

(() => {
  // --------- Config ---------
  const API_ORIGIN = location.origin;
  const STT_URL  = `${API_ORIGIN}/.netlify/functions/stt`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;
  const TTS_URL  = `${API_ORIGIN}/.netlify/functions/tts`;

  // Filler behavior
  const FILLER_THRESHOLD_MS = 1200;   // only speak filler if we wait longer than this
  const FILLER_COOLDOWN_MS  = 8000;   // don't speak fillers more than once per 8s
  const FILLER_MAX_PER_TURN = 1;

  // Auto-stop window for each take
  const AUTO_MS = 6000;

  // --------- Logger ---------
  const logEl = document.getElementById("log");
  function log(...args) {
    console.log("[CHAT]", ...args);
    if (!logEl) return;
    const line = args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    logEl.scrollTop = logEl.scrollHeight;
  }

  // --------- DOM wiring (new + legacy IDs) ---------
  function getButtons() {
    const record = document.getElementById("recordBtn") || document.querySelector('[data-action="record"]')
                 || document.getElementById("btnRecord");
    const stop   = document.getElementById("stopBtn") || document.querySelector('[data-action="stop"]')
                 || document.getElementById("btnStop");
    const say    = document.getElementById("sayBtn") || document.querySelector('[data-action="say"]')
                 || document.getElementById("btnSpeakTest");
    return { recordBtn: record, stopBtn: stop, sayBtn: say };
  }

  function wireUI() {
    const { recordBtn, stopBtn, sayBtn } = getButtons();
    if (!recordBtn || !stopBtn || !sayBtn) {
      log("UI buttons not found yet, retrying…");
      return false;
    }
    recordBtn.addEventListener("click", () => { log("record click"); startRecording(); });
    stopBtn.addEventListener("click",   () => { log("stop click");   stopRecording(); });
    sayBtn.addEventListener("click",    () => { log("tts click");    speak("Quick audio check."); });
    log("DOMContentLoaded; wiring handlers");
    return true;
  }

  let __tries = 0;
  function ensureWired() {
    if (wireUI()) {
      const uiOk = document.getElementById("uiOk");
      const uiBad = document.getElementById("uiBad");
      if (uiOk) uiOk.hidden = false;
      if (uiBad) uiBad.hidden = true;
      return;
    }
    if (__tries++ < 20) setTimeout(ensureWired, 250);
  }
  document.addEventListener("DOMContentLoaded", ensureWired);

  // --------- Audio state ---------
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoTimer = null;
  let lastTranscript = "";
  function clearTimer() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
  function stopTracks() { try { mediaStream?.getTracks?.().forEach(t => t.stop()); } catch {} mediaStream = null; }

  // --------- TTS ---------
  async function speak(text, opts = {}) {
    try {
      const payload = {
        text: String(text || ""),
        voice: opts.voice || undefined,
        speed: typeof opts.speed === "number" ? opts.speed : 1.0,
        format: "mp3",
        emotion: opts.emotion || undefined
      };
      const res = await fetch(TTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const buf = await res.arrayBuffer();
      if (!res.ok) {
        let detail = "";
        try { detail = new TextDecoder().decode(buf); } catch {}
        log("TTS error", res.status, detail);
        return;
      }
      const blob = new Blob([buf], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      log("TTS played", blob.size, "bytes");
    } catch (err) {
      log("TTS failed", String(err?.message || err));
    }
  }

  // --------- Smart Filler (rare) ---------
  const fillerPool = [
    { id: "quick",  text: "One sec…",               weight: 3 },
    { id: "think",  text: "Let me think…",          weight: 2 },
    { id: "soft",   text: "Hang on…",               weight: 2 },
    { id: "casual", text: "Umm…",                   weight: 1 },
    { id: "wow",    text: "Whoa—okay…",             weight: 1 }, // use sparingly; only for surprising asks
  ];
  let lastFillerTs = 0;
  let fillerCountThisTurn = 0;

  function pickFillerByContext(utterance) {
    const u = (utterance || "").toLowerCase();
    // Tiny context tweak
    if (u.includes("?what") || u.includes("explain") || u.endsWith("?")) return "Let me think…";
    if (u.includes("surprise") || u.includes("crazy") || u.includes("what the")) return "Whoa—okay…";
    // weighted default
    const total = fillerPool.reduce((s, f) => s + f.weight, 0);
    let r = Math.random() * total;
    for (const f of fillerPool) {
      if ((r -= f.weight) <= 0) return f.text;
    }
    return "One sec…";
  }

  // --------- Chat helper ---------
  let lastEmotion = null;

  async function askLLM(text) {
    const started = Date.now();
    fillerCountThisTurn = 0;
    let fillerTimer = null;
    let cancelled = false;

    // arm a filler but only actually fire if slow *and* cooldown passed
    fillerTimer = setTimeout(async () => {
      const now = Date.now();
      if (cancelled) return;
      if (fillerCountThisTurn >= FILLER_MAX_PER_TURN) return;
      if (now - lastFillerTs < FILLER_COOLDOWN_MS) return;

      const fill = pickFillerByContext(lastTranscript);
      await speak(fill, { speed: 1.04 });
      lastFillerTs = now;
      fillerCountThisTurn++;
    }, FILLER_THRESHOLD_MS);

    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: "global",
          message: text,
          emotion_state: lastEmotion || undefined,
          last_transcript: lastTranscript || undefined
        })
      });

      cancelled = true;
      clearTimeout(fillerTimer);

      const data = await res.json().catch(() => ({}));
      log("CHAT status", res.status, data);

      if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);

      lastEmotion = data?.next_emotion_state || lastEmotion;
      if (data.reply) {
        await speak(data.reply, { emotion: lastEmotion || undefined, speed: 1.02 });
      }
    } catch (err) {
      cancelled = true;
      clearTimeout(fillerTimer);
      log("askLLM failed", String(err?.message || err));
    }
  }

  // --------- STT ---------
  async function sttUploadBlob(blob) {
    const fd = new FormData();
    fd.append("file", blob, "speech.webm");
    const res = await fetch(STT_URL, { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    log("STT status", res.status, data, "via functions path");
    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  // --------- Recorder control (hands-free) ---------
  async function startRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      log("already recording; ignoring start");
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/ogg;codecs=opus";

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
      chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          chunks.push(e.data);
          log("chunk", e.data.type, e.data.size, "bytes");
        }
      };

      mediaRecorder.onstop = async () => {
        clearTimer();
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        log("final blob", blob.type, blob.size, "bytes");
        stopTracks();

        if (blob.size < 8192) {
          log("too small; speak a bit longer.");
          mediaRecorder = null;
          return;
        }

        try {
          const stt = await sttUploadBlob(blob);
          lastTranscript = stt.transcript || "";
          log("TRANSCRIPT:", lastTranscript);
          await askLLM(lastTranscript);
        } catch (err) {
          log("STT/CHAT failed", String(err?.message || err));
        } finally {
          mediaRecorder = null;
          chunks = [];
          // hands-free restart
          log("recorder reset — auto-listen ON, restarting…");
          startRecording();
        }
      };

      mediaRecorder.start();
      log("recording started with", mime);

      clearTimer();
      autoTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
          mediaRecorder.stop();
          log("recording stopped (auto)");
        }
      }, AUTO_MS);
    } catch (err) {
      log("mic error", String(err?.message || err));
      stopTracks(); mediaRecorder = null; chunks = []; clearTimer();
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      log("recording stopped (manual)");
      return;
    }
    log("stop clicked but no active recorder");
  }

  // Expose for console tests
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
