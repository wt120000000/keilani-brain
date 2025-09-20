// CHAT.JS BUILD TAG → 2025-09-20T09:40Z

(() => {
  // ---------- Config ----------
  const API_ORIGIN = location.origin; // api.keilani.ai
  const STT_URL  = `${API_ORIGIN}/.netlify/functions/stt`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;
  const TTS_URL  = `${API_ORIGIN}/.netlify/functions/tts`;

  // ---------- Logger ----------
  const logEl = document.getElementById("log");
  const setBuildTag = () => {
    const el = document.getElementById("buildTag");
    if (el) el.textContent = document.currentScript?.src?.split("v=")[1] || "dev";
  };
  const log = (...args) => {
    console.log("[CHAT]", ...args);
    if (!logEl) return;
    const line = args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    logEl.scrollTop = logEl.scrollHeight;
  };

  // ---------- DOM safe wiring ----------
  function qsAll(sel) { return Array.from(document.querySelectorAll(sel)); }
  function wireUI() {
    const recordBtn = document.getElementById("recordBtn") || qsAll('[data-action="record"]')[0];
    const stopBtn   = document.getElementById("stopBtn")   || qsAll('[data-action="stop"]')[0];
    const sayBtn    = document.getElementById("sayBtn")    || qsAll('[data-action="say"]')[0];

    if (!recordBtn || !stopBtn || !sayBtn) {
      log("UI buttons not found; check IDs/attrs.");
      return false;
    }
    recordBtn.addEventListener("click", () => { log("record click"); startRecording(); });
    stopBtn.addEventListener("click",   () => { log("stop click");   stopRecording(); });
    sayBtn.addEventListener("click",    () => { log("tts click");    speak("Hey — Keilani here.", { speed: 1.08 }); });

    const ok = document.getElementById("uiOk"), bad = document.getElementById("uiBad");
    ok && (ok.hidden = false); bad && (bad.hidden = true);
    log("DOMContentLoaded; wiring handlers");
    return true;
  }

  document.addEventListener("DOMContentLoaded", () => {
    setBuildTag();
    wireUI();
  });

  // ---------- Audio utils ----------
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoTimer = null;
  const AUTO_MS = 6000;

  function blobToB64(blob) {
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
    const b64 = await blobToB64(blob);
    const simpleMime = (blob.type || "").split(";")[0] || "application/octet-stream";
    const body = { audioBase64: b64, language: "en", mime: simpleMime, filename: simpleMime.includes("webm") ? "audio.webm" : "audio.bin" };
    const res = await fetch(STT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    log("STT status", res.status, data);
    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  async function speak(text, opts = {}) {
    const payload = {
      text: String(text || ""),
      voice: opts.voice || "alloy",
      speed: typeof opts.speed === "number" ? opts.speed : 1.0,
      format: "mp3",
      // pass-thru emotion if present
      emotion: opts.emotion || undefined
    };
    const res = await fetch(TTS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const buf = await res.arrayBuffer();
    if (!res.ok) {
      let detail = "";
      try { detail = new TextDecoder().decode(buf); } catch {}
      log("TTS error", res.status, detail);
      throw new Error(`TTS ${res.status}`);
    }
    const blob = new Blob([buf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    log("TTS played", blob.size, "bytes");
  }

  function clearTimer() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
  function stopTracks() { try { mediaStream?.getTracks?.().forEach(t => t.stop()); } catch {} mediaStream = null; }

  // ---------- Loop mode (auto continue) ----------
  let loopMode = false;
  let lastEmotion = null;

  async function askLLM(user_id, message) {
    // Small “thinking” filler if we suspect >300ms
    let cancelled = false;
    const filler = setTimeout(() => {
      if (!cancelled) speak("Gimme a sec…", { speed: 1.08 });
    }, 300);

    const body = { user_id, message, emotion_state: lastEmotion || undefined };
    const res = await fetch(CHAT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    clearTimeout(filler); cancelled = true;

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  // ---------- Recording control ----------
  async function startRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      log("already recording; ignoring start");
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/ogg;codecs=opus";
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferred });
      chunks = [];

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); log("chunk", e.data.type, e.data.size, "bytes"); } };
      mediaRecorder.onerror = (e) => { log("recorder error", String(e?.error || e?.name || e)); };
      mediaRecorder.onstop = async () => {
        clearTimer();
        const blob = new Blob(chunks, { type: preferred });
        log("final blob", blob.type, blob.size, "bytes");
        stopTracks();

        if (blob.size < 8192) { log("too small; speak a bit longer."); mediaRecorder = null; return; }

        // STT → CHAT → TTS
        try {
          const stt = await sttUploadBlob(blob);
          log("TRANSCRIPT:", stt.transcript);

          const reply = await askLLM("global", stt.transcript);
          lastEmotion = reply?.next_emotion_state || null;
          log("CHAT status", 200, reply);

          await speak(reply.reply || "Got it.", { emotion: lastEmotion || undefined, speed: 1.03 });
        } catch (err) {
          log("STT/CHAT failed", String(err?.message || err));
        } finally {
          mediaRecorder = null; chunks = [];
          if (loopMode) {
            // give the TTS tail a moment to clear the mic loopback
            setTimeout(() => startRecording(), 350);
          }
        }
      };

      mediaRecorder.start();
      log("recording started with", preferred);

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
