/* Keilani Brain — chat + voice (Edge streaming)
   - Text/SSE via /api/chat-stream (Edge Function)
   - STT via /.netlify/functions/stt
   - TTS via /.netlify/functions/tts
   - Push-to-talk with barge-in
*/

(() => {
  // ---------- Config ----------
  const CHAT_STREAM_URL = "/api/chat-stream";                // Edge route
  const STT_URL = "/.netlify/functions/stt";
  const TTS_URL = "/.netlify/functions/tts";

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

  // One audio element for playback
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

  // ---------- Small utils ----------
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

  // ---------- TTS ----------
  async function speak(text, voiceId = getVoice()) {
    if (!text || !text.trim()) return;
    setState("speaking");
    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: voiceId }),
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

  // ---------- SSE Chat (Edge) ----------
  async function chatStream(message, history = []) {
    setState("thinking");

    // single declaration; no redeclare
    const response = await backoff(() => fetch(CHAT_STREAM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    }));

    if (!response.ok || !response.body) {
      console.error("[chat-stream] HTTP", response.status);
      throw new Error("chat_stream_failed");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", finalText = "";

    // clear previous reply
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
          // non-JSON line, append raw
          finalText += data;
          if (replyEl) replyEl.textContent += data;
        }
      }
    }
    return finalText.trim();
  }

  // ---------- Text path ----------
  async function handleSend() {
    try {
      stopSpeaking(); // barge-in if speaking
      const text = (inputEl?.value || "").trim();
      if (!text) return;

      // session memory (simple, last 10)
      const history = JSON.parse(localStorage.getItem("kb_history") || "[]");
      const reply = await chatStream(text, history);

      // update memory
      const next = [...history, { role: "user", text }, { role: "assistant", text: reply }].slice(-10);
      localStorage.setItem("kb_history", JSON.stringify(next));

      if (getVoice()) await speak(reply, getVoice());
      else setState("idle");
    } catch (e) {
      console.error("[SEND] error", e);
      setState("idle");
    }
  }

  // ---------- Speak current ----------
  async function handleSpeak() {
    const text = (replyEl?.textContent || inputEl?.value || "").trim();
    if (!text) return;
    stopSpeaking();
    await speak(text, getVoice());
  }

  // ---------- PTT (hold to talk) ----------
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];

  function bestMime() {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) return "audio/ogg;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
    return "";
  }

  async function startPTT() {
    try {
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
      if (blob.size < 2000) {
        transcriptEl && (transcriptEl.textContent = "(no speech)");
        setState("idle");
        return;
      }
      const ab = await blob.arrayBuffer();
      const b64 = arrayBufferToBase64(ab);
      const dataUrl = `data:${blob.type || "audio/webm"};base64,${b64}`;

      // STT (with small retry)
      const sttResp = await backoff(() => fetch(STT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: dataUrl, language: "en" }),
      }));
      const sttJson = await sttResp.json().catch(() => ({}));
      if (!sttResp.ok) {
        console.warn("[PTT] STT", sttResp.status, sttJson);
        transcriptEl && (transcriptEl.textContent = "(stt error)");
        setState("idle");
        return;
      }

      const transcript = (sttJson.transcript || "").trim();
      transcriptEl && (transcriptEl.textContent = transcript || "(no speech)");
      if (!transcript) { setState("idle"); return; }

      // Chat + (optional) TTS
      const history = JSON.parse(localStorage.getItem("kb_history") || "[]");
      const reply = await chatStream(transcript, history);
      const next = [...history, { role: "user", text: transcript }, { role: "assistant", text: reply }].slice(-10);
      localStorage.setItem("kb_history", JSON.stringify(next));

      if (getVoice()) await speak(reply, getVoice());
      else setState("idle");
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

  // ---------- Wire UI ----------
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

  setState("idle");
  console.log("[Keilani] chat.js ready (Edge streaming)");
})();
