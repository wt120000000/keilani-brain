// public/assets/chat.js
// BUILD: 2025-09-21T01:15Z
// - No self-echo: pause auto-listen while TTS speaks; only restart after 'ended'.
// - Smart filler: only if slow + cooldown; never spam.
// - Faster turns: shorter take, responsive errors, echo-cancelled mic.

(() => {
  // --------- Config ---------
  const API_ORIGIN = location.origin;
  const STT_URL  = `${API_ORIGIN}/.netlify/functions/stt`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;
  const TTS_URL  = `${API_ORIGIN}/.netlify/functions/tts`;

  // Timing
  const AUTO_MS = 4500;                 // shorter clip for snappier turns
  const FILLER_THRESHOLD_MS = 1200;     // only speak filler if slow
  const FILLER_COOLDOWN_MS  = 8000;     // one every 8s max
  const FILLER_MAX_PER_TURN = 1;

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
    if (!recordBtn || !stopBtn || !sayBtn) { log("UI buttons not found yet, retrying…"); return false; }
    recordBtn.addEventListener("click", () => { log("record click"); startRecording(); });
    stopBtn.addEventListener("click",   () => { log("stop click");   stopRecording(); });
    sayBtn.addEventListener("click",    () => { log("tts click");    speak("Quick audio check."); });
    log("DOMContentLoaded; wiring handlers");
    const ok = document.getElementById("uiOk"); const bad = document.getElementById("uiBad");
    if (ok) ok.hidden = false; if (bad) bad.hidden = true;
    return true;
  }
  let __tries = 0;
  document.addEventListener("DOMContentLoaded", () => {
    if (wireUI()) return;
    const t = setInterval(() => { if (wireUI()) clearInterval(t); if (++__tries > 24) clearInterval(t); }, 250);
  });

  // --------- Audio state ---------
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoTimer = null;

  let lastTranscript = "";
  let lastEmotion = null;

  // speaking gate: don't record while TTS is playing
  let isSpeaking = false;

  function clearTimer() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
  function stopTracks() { try { mediaStream?.getTracks?.().forEach(t => t.stop()); } catch {} mediaStream = null; }

  // --------- TTS (returns AFTER audio ENDS) ---------
  async function speak(text, opts = {}) {
    try {
      const payload = {
        text: String(text || ""),
        voice: opts.voice || undefined,
        speed: typeof opts.speed === "number" ? opts.speed : 1.02,
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
        let detail = ""; try { detail = new TextDecoder().decode(buf); } catch {}
        log("TTS error", res.status, detail);
        return;
      }
      const blob = new Blob([buf], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      isSpeaking = true;
      await new Promise((resolve) => {
        audio.addEventListener("ended", () => { URL.revokeObjectURL(url); resolve(); }, { once: true });
        // play() resolves immediately; we wait for 'ended'
        audio.play().catch(err => { log("audio play failed", String(err?.message || err)); resolve(); });
      });
      log("TTS played", blob.size, "bytes");
    } catch (err) {
      log("TTS failed", String(err?.message || err));
    } finally {
      // tiny grace before reopening the mic
      setTimeout(() => { isSpeaking = false; }, 200);
    }
  }

  // --------- Smart Filler (rare) ---------
  const fillerPool = [
    { text: "One sec…",         weight: 3 },
    { text: "Let me think…",    weight: 2 },
    { text: "Hang on…",         weight: 2 },
    { text: "Umm…",             weight: 1 },
    { text: "Whoa—okay…",       weight: 1 }, // used rarely
  ];
  let lastFillerTs = 0;
  let fillerCountThisTurn = 0;
  function pickFiller(ctx = "") {
    const u = ctx.toLowerCase();
    if (u.includes("?") || u.includes("how") || u.includes("why")) return "Let me think…";
    if (u.includes("surprise") || u.includes("what the")) return "Whoa—okay…";
    const total = fillerPool.reduce((s, f) => s + f.weight, 0);
    let r = Math.random() * total;
    for (const f of fillerPool) { if ((r -= f.weight) <= 0) return f.text; }
    return "One sec…";
  }

  // --------- Chat helper ---------
  async function askLLM(text) {
    const started = Date.now();
    fillerCountThisTurn = 0;
    let fired = false;

    const fillerTimer = setTimeout(async () => {
      const now = Date.now();
      if (fired) return;
      if (fillerCountThisTurn >= FILLER_MAX_PER_TURN) return;
      if (now - lastFillerTs < FILLER_COOLDOWN_MS) return;
      await speak(pickFiller(lastTranscript), { speed: 1.04 });
      fillerCountThisTurn++; lastFillerTs = now; fired = true;
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
      clearTimeout(fillerTimer);

      const data = await res.json().catch(() => ({}));
      log("CHAT status", res.status, data);
      if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);

      lastEmotion = data?.next_emotion_state || lastEmotion;
      if (data.reply) {
        await speak(data.reply, { emotion: lastEmotion || undefined });
      }
    } catch (err) {
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

  // --------- Recorder control (hands-free, no echo) ---------
  async function startRecording() {
    // If we're speaking, wait and retry
    if (isSpeaking) { setTimeout(startRecording, 150); return; }

    if (mediaRecorder && mediaRecorder.state === "recording") {
      log("already recording; ignoring start"); return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000
        }
      });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/ogg;codecs=opus";

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
      chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) { chunks.push(e.data); log("chunk", e.data.type, e.data.size, "bytes"); }
      };

      mediaRecorder.onstop = async () => {
        clearTimer();
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        log("final blob", blob.type, blob.size, "bytes");
        stopTracks();

        if (blob.size < 8192) { log("too small; speak a bit longer."); mediaRecorder = null; return; }

        try {
          const stt = await sttUploadBlob(blob);
          lastTranscript = stt.transcript || "";
          log("TRANSCRIPT:", lastTranscript);
          await askLLM(lastTranscript);
        } catch (err) {
          log("STT/CHAT failed", String(err?.message || err));
        } finally {
          mediaRecorder = null; chunks = [];
          // Restart only when we’re not speaking (prevents self-echo)
          const wait = () => { if (isSpeaking) return setTimeout(wait, 150); log("recorder reset — auto-listen ON, restarting…"); startRecording(); };
          wait();
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
      mediaRecorder.stop(); log("recording stopped (manual)"); return;
    }
    log("stop clicked but no active recorder");
  }

  // Expose for console tests
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
