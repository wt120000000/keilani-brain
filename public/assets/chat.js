// public/assets/chat.js
// BUILD: 2025-09-20T20:30Z

(() => {
  // ---------- Config ----------
  const API_ORIGIN = location.origin;
  const STT_URL   = `${API_ORIGIN}/.netlify/functions/stt`;
  const CHAT_URL  = `${API_ORIGIN}/.netlify/functions/chat`;
  const TTS_URL   = `${API_ORIGIN}/.netlify/functions/tts`;
  const SEARCH_URL= `${API_ORIGIN}/.netlify/functions/search`;

  // ---------- Logger ----------
  const logEl = document.getElementById("log");
  const buildTagEl = document.getElementById("buildTag");
  const uiOk = document.getElementById("uiOk");
  const uiBad = document.getElementById("uiBad");
  if (buildTagEl) buildTagEl.textContent = (new Date()).toISOString();

  function log(...args) {
    console.log("[CHAT]", ...args);
    if (!logEl) return;
    const line = args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- DOM wiring (robust against older IDs) ----------
  function getButtons() {
    const record = document.getElementById("recordBtn") || document.querySelector('[data-action="record"]') || document.getElementById("btnRecord");
    const stop   = document.getElementById("stopBtn")   || document.querySelector('[data-action="stop"]')   || document.getElementById("btnStop");
    const say    = document.getElementById("sayBtn")    || document.querySelector('[data-action="say"]')    || document.getElementById("btnSpeakTest");
    const hands  = document.getElementById("handsFree");
    return {record, stop, say, hands};
  }

  function wireUI() {
    const {record, stop, say} = getButtons();
    if (!record || !stop || !say) return false;
    record.addEventListener("click", () => { log("record click"); startRecording(); });
    stop.addEventListener("click",   () => { log("stop click");   stopRecording(); });
    say.addEventListener("click",    () => { log("tts click");    speak("Hey — Keilani here. Testing one, two."); });
    if (uiOk) uiOk.hidden = false;
    if (uiBad) uiBad.hidden = true;
    log("DOMContentLoaded; wiring handlers");
    return true;
  }

  let tries = 0;
  function ensureWired() {
    if (wireUI()) return;
    if (uiOk) uiOk.hidden = true;
    if (uiBad) uiBad.hidden = false;
    if (tries++ < 20) setTimeout(ensureWired, 250);
  }
  document.addEventListener("DOMContentLoaded", ensureWired);

  // ---------- State ----------
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoTimer = null;
  const AUTO_MS = 6000;              // recorder auto-stop window
  let lastEmotion = null;

  function handsFreeOn() {
    const {hands} = getButtons();
    // default true if checkbox missing
    return hands ? !!hands.checked : true;
  }

  function clearTimer(){ if (autoTimer){ clearTimeout(autoTimer); autoTimer = null; } }
  function stopTracks(){ try { mediaStream?.getTracks?.().forEach(t => t.stop()); } catch {} mediaStream = null; }

  // ---------- STT upload (multipart FormData) ----------
  async function sttUploadBlob(blob) {
    const fd = new FormData();
    fd.append("file", blob, "speech.webm");
    const res = await fetch(STT_URL, { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    log("STT status", res.status, data, "via functions path");
    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  // ---------- TTS (returns a Promise that resolves when playback ends) ----------
  async function speak(text, opts = {}) {
    const payload = {
      text: String(text || ""),
      voice: opts.voice || undefined,   // use server default voice
      speed: typeof opts.speed === "number" ? opts.speed : 1.03,
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
    await new Promise((resolve) => {
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.play().then(() => log("TTS played", blob.size, "bytes"));
    });
  }

  // ---------- Search fallback ----------
  const TIMEY_HINTS = /(today|latest|now|this week|tonight|breaking|new\s+(update|drop|patch|release))/i;

  async function searchAndSummarize(query) {
    try {
      const res = await fetch(SEARCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: String(query || "").trim(), max: 5 })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`search ${res.status}: ${JSON.stringify(data)}`);

      // minimal voice-friendly summary
      const items = Array.isArray(data.results) ? data.results.slice(0,3) : [];
      if (!items.length) return null;

      const summary = items.map((r, i) => {
        const title = String(r.title || r.url || "result").replace(/\s+/g, " ").trim();
        return `${i+1}) ${title}`;
      }).join(". ");

      return {summary, raw: data};
    } catch (err) {
      log("search fallback failed", String(err?.message || err));
      return null;
    }
  }

  // ---------- LLM chat ----------
  async function askLLM(userText) {
    // filler so it feels responsive
    let fillerDone = false;
    const filler = setTimeout(async () => {
      if (!fillerDone) { try { await speak("Gimme a sec…", { speed: 1.08 }); } catch {} }
    }, 350);

    let data = null;
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: "global",
          message: userText,
          emotion_state: lastEmotion || undefined,
          allow_search: true   // tell backend it’s allowed to call /search
        })
      });
      data = await res.json().catch(() => ({}));
      clearTimeout(filler); fillerDone = true;
      log("CHAT status", res.status, data);
      if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);
    } catch (err) {
      clearTimeout(filler); fillerDone = true;
      log("askLLM failed", String(err?.message || err));
      return;
    }

    // If the backend didn’t actually search but the request was time-sensitive, do a quick client-side check.
    const wantsSearch = TIMEY_HINTS.test(userText) || /will\s+check|can\s+run\s+a\s+web\s+check/i.test(String(data.reply||""));
    if (wantsSearch && !data?.meta?.searched) {
      const result = await searchAndSummarize(userText);
      if (result && result.summary) {
        await speak(`Here’s the latest I’m seeing: ${result.summary}. If you want, I can dive deeper on one of those.`, { emotion: lastEmotion || undefined });
      }
    }

    if (data.reply) {
      await speak(data.reply, { emotion: data.next_emotion_state || lastEmotion || undefined });
    }
    lastEmotion = data.next_emotion_state || lastEmotion || null;

    // auto re-arm mic if hands-free enabled
    if (handsFreeOn()) {
      setTimeout(() => startRecording().catch(()=>{}), 120);
    }
  }

  // ---------- Recorder ----------
  async function startRecording() {
    // if already recording, ignore
    if (mediaRecorder && mediaRecorder.state === "recording") {
      log("already recording; ignoring start");
      return;
    }

    try {
      // make sure any old tracks are gone
      stopTracks();

      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/ogg;codecs=opus";

      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferred });
      chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) { chunks.push(e.data); log("chunk", e.data.type, e.data.size, "bytes"); }
      };

      mediaRecorder.onerror = (e) => log("recorder error", String(e?.error || e?.name || e));

      mediaRecorder.onstop = async () => {
        clearTimer();
        const blob = new Blob(chunks, { type: preferred });
        log("final blob", blob.type, blob.size, "bytes");
        stopTracks();

        if (blob.size < 8192) {
          log("too small; speak a bit longer.");
          mediaRecorder = null; chunks = []; return;
        }

        try {
          const stt = await sttUploadBlob(blob);
          log("TRANSCRIPT:", stt.transcript);
          await askLLM(stt.transcript);
        } catch (err) {
          log("STT/CHAT failed", String(err?.message || err));
          // even on failure, try to keep the loop going when hands-free
          if (handsFreeOn()) setTimeout(() => startRecording().catch(()=>{}), 350);
        } finally {
          mediaRecorder = null; chunks = []; mediaStream = null; clearTimer();
          log("recorder reset — ready");
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
      mediaRecorder.stop();
      log("recording stopped (manual)");
      return;
    }
    log("stop clicked but no active recorder");
  }

  // ---------- Expose for console tests ----------
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
