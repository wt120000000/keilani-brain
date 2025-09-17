/* Keilani Brain — chat + voice (Edge streaming)
   - Edge SSE:      /api/chat-stream
   - STT:           /.netlify/functions/stt
   - TTS:           /.netlify/functions/tts
   - Voices list:   /.netlify/functions/voices
   - Push-to-talk with barge-in, retries, voice picker + persistence
*/

(() => {
  // ---------- Config ----------
  const CHAT_STREAM_URL = "/api/chat-stream";     // Edge route
  const STT_URL  = "/.netlify/functions/stt";
  const TTS_URL  = "/.netlify/functions/tts";
  const VOICES_URL = "/.netlify/functions/voices";

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const inputEl      = $("#textIn") || $("textarea");
  const sendBtn      = $("#sendBtn") || $("#send");
  const speakBtn     = $("#speakBtn");
  const pttBtn       = $("#pttBtn") || $("#holdToTalk");
  const voiceSel     = $("#voicePick") || $("#voice");
  const transcriptEl = $("#transcriptBox") || $("#transcript");
  const replyEl      = $("#reply");
  const statePill    = $("#statePill") || $("#status");

  // One audio element
  const player = (() => {
    let a = $("#ttsPlayer");
    if (!a) {
      a = document.createElement("audio");
      a.id = "ttsPlayer";
      a.preload = "none";
      a.controls = true;
      document.body.appendChild(a);
    }
    return a;
  })();

  // Unlock audio once
  let audioUnlocked = false;
  function unlockAudioOnce() {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ac = new AC();
        if (ac.state === "suspended") ac.resume();
      }
      player.muted = false;
      audioUnlocked = true;
    } catch {}
  }
  document.addEventListener("pointerdown", unlockAudioOnce, { once: true });

  // ---------- Utils ----------
  const setState = (s) => { if (statePill) statePill.textContent = s; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const getVoice = () => (voiceSel && voiceSel.value) || "";

  async function backoff(fn, tries = 3, base = 300) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); }
      catch (e) { lastErr = e; await sleep(base * Math.pow(2, i)); }
    }
    throw lastErr;
  }

  function stopSpeaking() {
    try { player.pause(); player.currentTime = 0; } catch {}
  }

  // ---------- Voices ----------
  async function loadVoices() {
    if (!voiceSel) return;
    try {
      const res = await fetch(VOICES_URL);
      const data = res.ok ? await res.json() : {};
      const list = Array.isArray(data?.voices) ? data.voices : [];

      const saved = localStorage.getItem("kb_voice_id") || "";
      voiceSel.innerHTML = "";
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = "(default / no TTS)";
      voiceSel.appendChild(opt0);

      for (const v of list) {
        const id = v.id || v.voice_id || "";
        const name = v.name || v.display_name || (id ? id.slice(0, 8) : "Voice");
        if (!id) continue;
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = name;
        voiceSel.appendChild(opt);
      }
      if (saved && [...voiceSel.options].some(o => o.value === saved)) {
        voiceSel.value = saved;
      }
      voiceSel.addEventListener("change", () => {
        localStorage.setItem("kb_voice_id", voiceSel.value || "");
      });
    } catch (e) {
      console.warn("[VOICES] load error", e);
    }
  }

  // ---------- TTS ----------
  async function speak(text, voiceId = getVoice()) {
    if (!text || !text.trim()) return;
    setState("speaking");
    const body = { text };
    if (voiceId) body.voice = voiceId;

    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn("[TTS] HTTP", res.status);
      setState("idle");
      return;
    }
    const buf = await res.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
    player.src = url;
    try { await player.play(); } catch (e) { console.warn("[TTS] autoplay", e); }
    player.onended = () => setState("idle");
  }

  // ---------- Chat SSE ----------
  async function chatStream(message, history = []) {
    setState("thinking");
    const response = await backoff(() => fetch(CHAT_STREAM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    }));
    if (!response.ok || !response.body) throw new Error("chat_stream_failed");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", finalText = "";
    if (replyEl) replyEl.textContent = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const obj = JSON.parse(data);
          const chunk = obj.delta || "";
          if (chunk) {
            finalText += chunk;
            if (replyEl) replyEl.textContent += chunk;
          }
        } catch {
          finalText += data;
          if (replyEl) replyEl.textContent += data;
        }
      }
    }
    return finalText.trim();
  }

  // ---------- Text send ----------
  async function handleSend() {
    try {
      unlockAudioOnce();
      stopSpeaking();
      const text = (inputEl?.value || "").trim();
      if (!text) return;

      const history = JSON.parse(localStorage.getItem("kb_history") || "[]");
      const reply = await chatStream(text, history);
      const next = [...history, { role: "user", text }, { role: "assistant", text: reply }].slice(-10);
      localStorage.setItem("kb_history", JSON.stringify(next));
      await speak(reply, getVoice());
    } catch (e) {
      console.error("[SEND] error", e);
      setState("idle");
    }
  }

  // ---------- Speak current ----------
  async function handleSpeak() {
    unlockAudioOnce();
    const text = (replyEl?.textContent || inputEl?.value || "").trim();
    if (!text) return;
    stopSpeaking();
    await speak(text, getVoice());
  }

  // ---------- PTT ----------
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];

  const isFirefox = () => /firefox/i.test(navigator.userAgent);

  function bestMime() {
    // Prefer OGG on Firefox (more reliable with OpenAI)
    if (isFirefox() && MediaRecorder.isTypeSupported("audio/ogg;codecs=opus"))
      return "audio/ogg;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus"))
      return "audio/webm;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus"))
      return "audio/ogg;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/webm"))
      return "audio/webm";
    return "";
  }

  async function startPTT() {
    try {
      unlockAudioOnce();
      stopSpeaking(); // barge-in
      setState("listening");
      chunks = [];

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });

      const mime = bestMime();
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = onPTTStop;
      mediaRecorder.start(250);
      console.log("[PTT] recording… mime=", mime);
    } catch (e) {
      console.error("[PTT] start error", e);
      setState("idle");
    }
  }

  function stopPTT() {
    try {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.requestData?.();
        mediaRecorder.stop();
      }
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    } catch (e) { console.warn("[PTT] stop", e); }
  }

  async function onPTTStop() {
    try {
      setState("transcribing");
      if (!chunks.length) {
        transcriptEl && (transcriptEl.textContent = "(no audio)");
        setState("idle");
        return;
      }
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || bestMime() });
      const sizeKB = Math.round(blob.size / 1024);

      // Avoid tiny blobs that produce 400s
      if (blob.size < 8 * 1024) {
        transcriptEl && (transcriptEl.textContent = "(no speech)");
        console.log("[PTT] blob too small:", sizeKB, "KB");
        setState("idle");
        return;
      }

      const ab = await blob.arrayBuffer();
      const b64 = arrayBufferToBase64(ab);
      const dataUrl = `data:${blob.type || "audio/webm"};base64,${b64}`;

      const sttResp = await backoff(() => fetch(STT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: dataUrl, language: "en" }),
      }));
      const sttJson = await sttResp.json().catch(() => ({}));
      console.log("[PTT] STT", sttResp.status, sttJson);

      if (!sttResp.ok) {
        transcriptEl && (transcriptEl.textContent = "(stt error)");
        setState("idle");
        return;
      }

      const transcript = (sttJson.transcript || "").trim();
      transcriptEl && (transcriptEl.textContent = transcript || "(no speech)");
      if (!transcript) { setState("idle"); return; }

      const history = JSON.parse(localStorage.getItem("kb_history") || "[]");
      const reply = await chatStream(transcript, history);
      const next = [...history, { role: "user", text: transcript }, { role: "assistant", text: reply }].slice(-10);
      localStorage.setItem("kb_history", JSON.stringify(next));
      await speak(reply, getVoice());
    } catch (e) {
      console.error("[PTT] flow error", e);
      setState("idle");
    } finally {
      chunks = [];
      mediaRecorder = null;
      mediaStream = null;
    }
  }

  function arrayBufferToBase64(ab) {
    const bytes = new Uint8Array(ab);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // ---------- Wire + init ----------
  sendBtn && sendBtn.addEventListener("click", handleSend);
  speakBtn && speakBtn.addEventListener("click", handleSpeak);

  if (pttBtn) {
    pttBtn.addEventListener("pointerdown", startPTT);
    pttBtn.addEventListener("pointerup", stopPTT);
    pttBtn.addEventListener("pointerleave", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") stopPTT();
    });
  }

  if (inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
  }

  loadVoices();
  setState("idle");
  console.log("[Keilani] chat.js ready (Edge streaming + voices)");
})();
