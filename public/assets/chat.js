// public/assets/chat.js
// BUILD: 2025-09-20T21:45Z

(() => {
  // --------- Config ---------
  const API_ORIGIN = location.origin;
  const STT_URL  = `${API_ORIGIN}/.netlify/functions/stt`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;
  const TTS_URL  = `${API_ORIGIN}/.netlify/functions/tts`;

  // --------- Logger ---------
  const logEl = document.getElementById("log");
  function log(...args) {
    console.log("[CHAT]", ...args);
    if (!logEl) return;
    const line = args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    logEl.scrollTop = logEl.scrollHeight;
  }
  if (logEl && !logEl.textContent) logEl.textContent = "DOM not ready…";

  // --------- DOM wiring (supports new & legacy IDs) ---------
  function getButtons() {
    const record = document.getElementById("recordBtn") || document.querySelector('[data-action="record"]');
    const stop   = document.getElementById("stopBtn")   || document.querySelector('[data-action="stop"]');
    const say    = document.getElementById("sayBtn")    || document.querySelector('[data-action="say"]');

    const legacyRecord = document.getElementById("btnRecord");
    const legacyStop   = document.getElementById("btnStop");
    const legacySay    = document.getElementById("btnSpeakTest");

    return {
      recordBtn: record || legacyRecord || null,
      stopBtn:   stop   || legacyStop   || null,
      sayBtn:    say    || legacySay    || null,
    };
  }

  function wireUI() {
    const { recordBtn, stopBtn, sayBtn } = getButtons();
    if (!recordBtn || !stopBtn || !sayBtn) {
      log("UI buttons not found yet, retrying…");
      return false;
    }
    recordBtn.addEventListener("click", () => { log("record click"); startRecording(); });
    stopBtn.addEventListener("click",   () => { log("stop click");   stopRecording(); });
    sayBtn.addEventListener("click",    () => { log("tts click");    speak("Hey — Keilani here.", { speed: 1.08 }); });
    log("DOMContentLoaded; wiring handlers");
    return true;
  }

  let __wireTries = 0;
  function ensureWired() {
    if (wireUI()) return;
    if (__wireTries++ < 20) setTimeout(ensureWired, 250);
  }
  document.addEventListener("DOMContentLoaded", ensureWired);

  // --------- Audio helpers ---------
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoTimer = null;
  const AUTO_MS = 6000;

  function clearTimer() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
  function stopTracks() { try { mediaStream?.getTracks?.().forEach(t => t.stop()); } catch {} mediaStream = null; }

  function blobToBase64Raw(blob) {
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

  // ---- STT: send JSON (base64) to match backend ----
  async function sttUploadBlob_JSON(blob) {
    const audioBase64 = await blobToBase64Raw(blob);
    const simpleMime = (blob.type || "").split(";")[0] || "application/octet-stream";
    const filename =
      simpleMime.includes("webm") ? "audio.webm" :
      simpleMime.includes("ogg")  ? "audio.ogg"  :
      simpleMime.includes("mpeg") || simpleMime.includes("mp3") ? "audio.mp3" :
      simpleMime.includes("m4a") || simpleMime.includes("mp4") ? "audio.m4a" :
      simpleMime.includes("wav")  ? "audio.wav"  : "audio.bin";

    const body = { audioBase64, language: "en", mime: simpleMime, filename };

    const res = await fetch(STT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    log("STT status", res.status, data, "via functions path");
    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  // --------- TTS with 404 fallback (no hard-coded voice) ---------
  async function speak(text, opts = {}) {
    async function requestTTS(payload) {
      const res = await fetch(TTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const buf = await res.arrayBuffer();
      return { res, buf };
    }

    // First try: pass through opts.voice if caller provided; otherwise omit voice
    const basePayload = {
      text: String(text || ""),
      speed: typeof opts.speed === "number" ? opts.speed : 1.0,
      format: "mp3",
      // If your server uses ELEVEN_VOICE_ID default, leaving `voice` undefined
      // will make it choose that env-configured voice.
      voice: opts.voice, // may be undefined
      emotion: opts.emotion || undefined,
    };

    let { res, buf } = await requestTTS(basePayload);

    // If the chosen voice doesn't exist on the Eleven account, retry once without voice
    if (res.status === 404 || res.status === 400) {
      try {
        const detail = new TextDecoder().decode(buf);
        log("TTS first attempt failed", res.status, detail);
      } catch {}
      if (basePayload.voice) {
        delete basePayload.voice;
        ({ res, buf } = await requestTTS(basePayload));
      }
    }

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

  // --------- Chat helper (with filler) ---------
  let lastEmotion = null;
  async function askLLM(text) {
    let cancelled = false;
    const filler = setTimeout(() => { if (!cancelled) speak("Gimme a sec…", { speed: 1.08 }); }, 350);

    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "global", message: text, emotion_state: lastEmotion || undefined })
    });
    clearTimeout(filler); cancelled = true;

    const data = await res.json().catch(() => ({}));
    log("CHAT status", res.status, data);
    if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);

    lastEmotion = data?.next_emotion_state || null;
    if (data.reply) await speak(data.reply, { emotion: lastEmotion || undefined, speed: 1.03 });
  }

  // --------- Recording control ---------
  let mediaPreferred = "audio/webm;codecs=opus";

  async function startRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      log("already recording; ignoring start");
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaPreferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/ogg;codecs=opus";
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mediaPreferred });
      chunks = [];

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); log("chunk", e.data.type, e.data.size, "bytes"); } };
      mediaRecorder.onerror = (e) => { log("recorder error", String(e?.error || e?.name || e)); };
      mediaRecorder.onstop = async () => {
		clearTimer();
		const blob = new Blob(chunks, { type: mediaPreferred });
		log("final blob", blob.type, blob.size, "bytes");
		stopTracks();

	  if (blob.size < 8192) {
		log("too small; speak a bit longer.");
		mediaRecorder = null;
		return;
	  }

	  try {
		const stt = await sttUploadBlob_JSON(blob);
		log("TRANSCRIPT:", stt.transcript);
		await askLLM(stt.transcript);
	  } catch (err) {
		log("STT/CHAT failed", String(err?.message || err));
	  } finally {
    // Reset for next recording cycle
		mediaRecorder = null;
		chunks = [];
		mediaStream = null;
		clearTimer();
		log("recorder reset — ready for next click");
	  }
	};

      mediaRecorder.start();
      log("recording started with", mediaPreferred);

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

  // Expose for console
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
