// public/assets/chat.js
// BUILD: 2025-09-20T23:00Z  (STT -> JSON base64)

(() => {
  const API_ORIGIN = location.origin;
  const STT_URL  = `${API_ORIGIN}/.netlify/functions/stt`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;
  const TTS_URL  = `${API_ORIGIN}/.netlify/functions/tts`;

  const logEl = document.getElementById("log");
  function log(...args) {
    console.log("[CHAT]", ...args);
    if (!logEl) return;
    const line = args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function getButtons() {
    const record = document.getElementById("recordBtn") || document.querySelector('[data-action="record"]');
    const stop   = document.getElementById("stopBtn")   || document.querySelector('[data-action="stop"]');
    const say    = document.getElementById("sayBtn")    || document.querySelector('[data-action="say"]');
    return { recordBtn: record, stopBtn: stop, sayBtn: say };
  }

  function wireUI() {
    const { recordBtn, stopBtn, sayBtn } = getButtons();
    if (!recordBtn || !stopBtn || !sayBtn) { log("UI buttons not found yet"); return false; }
    recordBtn.addEventListener("click", startRecording);
    stopBtn.addEventListener("click", stopRecording);
    sayBtn.addEventListener("click", () => speak("Mic check one two.", { speed: 1.05 }));
    log("DOMContentLoaded; wiring handlers");
    return true;
  }
  document.addEventListener("DOMContentLoaded", () => { wireUI() || setTimeout(wireUI, 300); });

  let mediaRecorder = null, mediaStream = null, chunks = [], autoTimer = null;
  const AUTO_MS = 6000;
  function clearTimer(){ if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
  function stopTracks(){ try { mediaStream?.getTracks?.().forEach(t => t.stop()); } catch {} mediaStream = null; }

  async function speak(text, opts = {}) {
    try {
      const res = await fetch(TTS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, ...opts }) });
      const buf = await res.arrayBuffer();
      if (!res.ok) throw new Error(new TextDecoder().decode(new Uint8Array(buf)));
      const blob = new Blob([buf], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      log("TTS played", blob.size, "bytes");
    } catch (e) { log("TTS failed", String(e)); }
  }

  // --- STT helper: blob -> base64 and POST JSON ----
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onloadend = () => {
        const s = fr.result || "";
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async function sttUploadBlob(blob) {
    const audioBase64 = await blobToBase64(blob);
    const payload = { audioBase64, mime: blob.type || "audio/webm", filename: "speech.webm" };
    const res = await fetch(STT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    log("STT status", res.status, data);
    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  let lastEmotion = null;
  async function askLLM(text) {
    let cancelled = false;
    const fillers = ["Gimme a sec…", "uh…", "hold on…", "one moment…"];
    const fillerTimeout = setTimeout(() => {
      if (!cancelled) speak(fillers[Math.floor(Math.random() * fillers.length)], { speed: 1.04 });
    }, 700); // only if model is slow

    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "global", message: text, emotion_state: lastEmotion || undefined })
    });
    clearTimeout(fillerTimeout); cancelled = true;

    const data = await res.json().catch(() => ({}));
    log("CHAT status", res.status, data);
    if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);

    lastEmotion = data?.next_emotion_state || null;
    if (data.reply) await speak(data.reply, { emotion: lastEmotion || undefined, speed: 1.03 });
  }

  async function startRecording() {
    if (mediaRecorder?.state === "recording") return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/ogg;codecs=opus";
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferred });
      chunks = [];

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        clearTimer();
        const blob = new Blob(chunks, { type: preferred });
        log("final blob", blob.type, blob.size, "bytes");
        stopTracks();

        if (blob.size < 8192) { log("too small; speak longer"); mediaRecorder = null; return; }
        try {
          const stt = await sttUploadBlob(blob);
          log("TRANSCRIPT:", stt.transcript);
          await askLLM(stt.transcript);
        } catch (e) {
          log("STT/CHAT failed", String(e));
        } finally {
          mediaRecorder = null; chunks = [];
        }
      };

      mediaRecorder.start();
      log("recording started with", preferred);
      autoTimer = setTimeout(() => {
        if (mediaRecorder?.state === "recording") {
          mediaRecorder.stop();
          log("recording stopped (auto)");
        }
      }, AUTO_MS);
    } catch (e) {
      log("mic error", String(e));
      stopTracks(); mediaRecorder = null; chunks = []; clearTimer();
    }
  }

  function stopRecording() {
    if (mediaRecorder?.state === "recording") {
      mediaRecorder.stop();
      log("recording stopped (manual)");
    }
  }

  // Expose for console
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
