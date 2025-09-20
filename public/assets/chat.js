// public/assets/chat.js
// BUILD: 2025-09-20T21:10Z

(() => {
  // ---------- Config ----------
  const API_ORIGIN = location.origin;
  const STT_URL  = `${API_ORIGIN}/.netlify/functions/stt`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;
  const TTS_URL  = `${API_ORIGIN}/.netlify/functions/tts`;

  // ---------- Log ----------
  const logEl = document.getElementById("log");
  function log(...args) {
    console.log("[CHAT]", ...args);
    if (!logEl) return;
    const line = args
      .map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)))
      .join(" ");
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- DOM wiring (new & legacy ids) ----------
  function getButtons() {
    const record = document.getElementById("recordBtn") || document.querySelector('[data-action="record"]');
    const stop   = document.getElementById("stopBtn")   || document.querySelector('[data-action="stop"]');
    const say    = document.getElementById("sayBtn")    || document.querySelector('[data-action="say"]');
    // legacy fallbacks
    const legacyRecord = document.getElementById("btnRecord");
    const legacyStop   = document.getElementById("btnStop");
    const legacySay    = document.getElementById("btnSpeakTest");
    return {
      recordBtn: record || legacyRecord || null,
      stopBtn:   stop   || legacyStop   || null,
      sayBtn:    say    || legacySay    || null,
    };
  }
  const autoListenChk = (function () {
    // support either an existing checkbox with id="autoListen"
    // or inject one (keeps CSP-friendly—no inline JS).
    let el = document.getElementById("autoListen");
    if (!el) {
      try {
        const row = document.querySelector(".row") || document.body;
        const wrap = document.createElement("label");
        wrap.style.display = "inline-flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "8px";
        wrap.style.marginLeft = "10px";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = "autoListen";
        const txt = document.createElement("span");
        txt.textContent = "Hands-free (auto-listen)";
        wrap.appendChild(cb);
        wrap.appendChild(txt);
        row?.appendChild(wrap);
        el = cb;
      } catch {}
    }
    return el;
  })();

  function wireUI() {
    const { recordBtn, stopBtn, sayBtn } = getButtons();
    if (!recordBtn || !stopBtn || !sayBtn) {
      log("UI buttons not found yet, retrying…");
      return false;
    }
    recordBtn.addEventListener("click", () => { log("record click"); startRecording(); });
    stopBtn.addEventListener("click",   () => { log("stop click");   stopRecording(); });
    sayBtn.addEventListener("click",    () => { log("tts click");    speak("Hey — Keilani here.", { speed: 1.06 }); });
    log("DOMContentLoaded; wiring handlers");
    const ok = document.getElementById("uiOk"), bad = document.getElementById("uiBad");
    if (ok) ok.hidden = false;
    if (bad) bad.hidden = true;
    return true;
  }
  let __tries = 0;
  function ensureWired() {
    if (wireUI()) return;
    if (__tries++ < 20) setTimeout(ensureWired, 250);
  }
  document.addEventListener("DOMContentLoaded", ensureWired);

  // ---------- Recorder state ----------
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoStopTimer = null;
  const AUTO_STOP_MS = 6000;

  function clearAutoStop() { if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; } }
  function stopTracks() {
    try { mediaStream?.getTracks?.().forEach(t => t.stop()); } catch {}
    mediaStream = null;
  }

  // ---------- Helpers ----------
  function blobToBase64Raw(blob) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onloadend = () => {
        const s = rd.result || "";
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      rd.onerror = reject;
      rd.readAsDataURL(blob);
    });
  }

  // Always JSON (base64) to match your stt function
  async function sttUploadBlobJSON(blob, mimeHint) {
    const base64 = await blobToBase64Raw(blob);
    const simpleMime = mimeHint || (blob.type || "audio/webm");
    const filename =
      simpleMime.includes("webm") ? "audio.webm" :
      simpleMime.includes("ogg")  ? "audio.ogg"  :
      simpleMime.includes("mp3")  ? "audio.mp3"  :
      simpleMime.includes("m4a") || simpleMime.includes("mp4") ? "audio.m4a" :
      simpleMime.includes("wav")  ? "audio.wav"  : "audio.bin";

    const body = {
      audioBase64: base64,
      language: "en",
      mime: simpleMime,
      filename
    };

    const res = await fetch(STT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    log("STT status", res.status, data, "via functions path");
    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  // ---------- TTS ----------
  async function speak(text, opts = {}) {
    const payload = {
      text: String(text || ""),
      voice: opts.voice || undefined,       // server will use default env voice if omitted
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
      throw new Error(`TTS ${res.status}`);
    }

    const blob = new Blob([buf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      audio.play().catch(reject);
    });
    log("TTS played", blob.size, "bytes");
  }

  // ---------- Chat ----------
  let lastEmotion = null;

  async function askLLM(text) {
    let cancelled = false;
    const filler = setTimeout(() => {
      if (!cancelled) speak("Gimme a sec…", { speed: 1.08 });
    }, 400);

    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "global",
        message: text,
        emotion_state: lastEmotion || undefined
      })
    });

    cancelled = true;
    clearTimeout(filler);

    const data = await res.json().catch(() => ({}));
    log("CHAT status", res.status, data);
    if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);

    lastEmotion = data?.next_emotion_state || null;
    if (data.reply) {
      await speak(data.reply, { emotion: lastEmotion || undefined, speed: 1.03 });
    }
  }

  // ---------- Recording ----------
  async function startRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      log("already recording; ignoring start");
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/ogg;codecs=opus";

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferred });
      chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          chunks.push(e.data);
          log("chunk", e.data.type, e.data.size, "bytes");
        }
      };

      mediaRecorder.onerror = (e) => {
        log("recorder error", String(e?.error || e?.name || e));
      };

      mediaRecorder.onstop = async () => {
        clearAutoStop();
        const blob = new Blob(chunks, { type: preferred });
        log("final blob", blob.type, blob.size, "bytes");
        stopTracks();

        if (blob.size < 8192) {
          log("too small; speak a bit longer.");
          mediaRecorder = null;
          return maybeReady();
        }

        try {
          const stt = await sttUploadBlobJSON(blob, preferred);
          log("TRANSCRIPT:", stt.transcript);
          await askLLM(stt.transcript);
        } catch (err) {
          log("STT/CHAT failed", String(err?.message || err));
        } finally {
          mediaRecorder = null;
          chunks = [];
          maybeReady();
        }
      };

      mediaRecorder.start();
      log("recording started with", preferred);

      clearAutoStop();
      autoStopTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
          mediaRecorder.stop();
          log("recording stopped (auto)");
        }
      }, AUTO_STOP_MS);
    } catch (err) {
      log("mic error", String(err?.message || err));
      stopTracks();
      mediaRecorder = null;
      chunks = [];
      clearAutoStop();
      maybeReady();
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

  // After TTS finishes, we drop back here; if hands-free is on, auto-rearm.
  function maybeReady() {
    const auto = !!(autoListenChk && autoListenChk.checked);
    if (auto) {
      log("recorder reset — auto-listen ON, restarting…");
      // small pause so the capture truly releases before re-grab
      setTimeout(() => startRecording(), 150);
    } else {
      log("recorder reset — ready for next click");
    }
  }

  // ---------- Expose for console ----------
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
