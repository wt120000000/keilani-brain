/* public/assets/chat.js */

const $ = (id) => document.getElementById(id);

// Map to older IDs if present (backward compat)
function bind(id, fallbackIds = []) {
  return $(id) || fallbackIds.map($).find(Boolean) || null;
}

// --- Elements (new IDs, with fallbacks to your earlier page) ---
const elTextIn     = bind("textIn",     ["textIn", "message"]);
const elSendBtn    = bind("sendBtn",    ["sendText"]);
const elSpeakBtn   = bind("speakBtn",   ["speakReply"]);
const elVoiceSel   = bind("voiceSelect",["voiceSelect"]);
const elReply      = bind("reply",      ["reply"]);
const elRecBtn     = bind("recBtn",     ["pttBtn"]);
const elRecState   = bind("recState",   ["recState"]);
const elTranscript = bind("transcript", ["transcript"]);
const elAudio      = bind("ttsPlayer",  ["ttsPlayer"]);
const elAvatar     = bind("avatarFeed", ["avatarFeed"]);

// ----------------------------- Globals -----------------------------
let currentAbort = null;
let micStream = null;
let mediaRecorder = null;
let mediaChunks = [];
let isRecording = false;

if (elAudio) elAudio.loop = false;

const TTS_MAX_QUEUE = 6;
let ttsQueue = [];
let speaking = false;
let ttsAbort = null;
const spokenSet = new Set();

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function resetSpoken() { if (spokenSet.size > 200) spokenSet.clear(); }

function clearTTS(reason = "user") {
  try { if (ttsAbort) ttsAbort.abort(); } catch {}
  ttsAbort = null;
  speaking = false;
  ttsQueue = [];
  if (elAudio) {
    try {
      elAudio.pause();
      elAudio.currentTime = 0;
      if (elAudio.src) URL.revokeObjectURL(elAudio.src);
      elAudio.removeAttribute("src");
      elAudio.load();
    } catch {}
  }
}

async function playNext() {
  if (speaking || ttsQueue.length === 0) return;
  speaking = true;

  const { text, voiceId } = ttsQueue.shift();
  ttsAbort = new AbortController();

  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal: ttsAbort.signal,
    });
    if (!res.ok) throw new Error(`tts http ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    elAudio.onended = () => {
      try { URL.revokeObjectURL(url); } catch {}
      speaking = false;
      ttsAbort = null;
      resetSpoken();
      playNext();
    };
    elAudio.onerror = () => {
      try { URL.revokeObjectURL(url); } catch {}
      speaking = false;
      ttsAbort = null;
      playNext();
    };

    elAudio.src = url;
    await elAudio.play().catch(() => {});
  } catch {
    speaking = false;
    ttsAbort = null;
    playNext();
  }
}

function enqueueTTS(text, voiceId) {
  const sentence = (text || "").trim();
  if (!sentence) return;
  const key = hash(sentence);
  if (spokenSet.has(key)) return;
  spokenSet.add(key);

  if (ttsQueue.length >= TTS_MAX_QUEUE) ttsQueue.shift();
  ttsQueue.push({ text: sentence, voiceId });
  playNext();
}
function cancelSpeech() { clearTTS("interrupt"); }

function feedAvatar(text) {
  if (elAvatar) elAvatar.textContent = (text || "").slice(0, 1200);
}

// --------------------------- Chat Streaming ---------------------------
const SENTENCE_BOUNDARY = /[.!?]\s$/;

async function streamSSE(url, body, { onOpen, onError, onPartial, onDone }) {
  if (currentAbort) { try { currentAbort.abort(); } catch {} }
  currentAbort = new AbortController();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: currentAbort.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`chat-stream http ${res.status}: ${text?.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  onOpen?.();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const lines = raw.split("\n");
      let event = "message";
      let data = "";
      for (const ln of lines) {
        if (ln.startsWith("event:")) event = ln.slice(6).trim();
        else if (ln.startsWith("data:")) data += ln.slice(5).trim();
      }

      if (event === "error") {
        try { onError?.(JSON.parse(data)); } catch { onError?.({ error: data }); }
        continue;
      }
      if (event === "done") { onDone?.(); continue; }
      if (event === "open" || event === "ping") continue;

      try {
        const j = JSON.parse(data);
        const chunk = j?.choices?.[0]?.delta?.content ?? "";
        if (chunk) onPartial?.(chunk);
      } catch {}
    }
  }
}

async function chatStream(userText) {
  cancelSpeech();
  feedAvatar("");
  if (elReply) elReply.textContent = "";
  let live = "";

  const voiceId = getSelectedVoiceId();

  function handlePartial(delta) {
    live += delta;
    if (elReply) elReply.textContent = live;
    feedAvatar(live);

    if (SENTENCE_BOUNDARY.test(live)) {
      enqueueTTS(live.trim(), voiceId);
      live = "";
    }
  }
  function handleDone() {
    const tail = live.trim();
    if (tail) enqueueTTS(tail, voiceId);
  }
  function handleError(e) {
    const msg = e?.error || e?.text || "stream error";
    if (elReply) elReply.textContent = `⚠ ${msg}`;
  }

  try {
    await streamSSE("/api/chat-stream", { message: userText }, {
      onOpen() {},
      onPartial: handlePartial,
      onDone: handleDone,
      onError: handleError,
    });
  } catch (err) {
    if (elReply) elReply.textContent = `⚠ ${String(err).slice(0, 240)}`;
  } finally {
    currentAbort = null;
  }
}

// ------------------------------- STT --------------------------------
async function startRecording() {
  cancelSpeech();
  if (isRecording) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    if (elRecState) elRecState.textContent = "mic denied";
    return;
  }

  if (elRecState) elRecState.textContent = "recording…";
  mediaChunks = [];
  mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
  isRecording = true;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) mediaChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    isRecording = false;
    if (elRecState) elRecState.textContent = "processing…";
    try {
      const blob = new Blob(mediaChunks, { type: "audio/webm" });
      const b64 = await blobToBase64(blob);

      const sttRes = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: b64 }),
      });

      if (!sttRes.ok) throw new Error(await sttRes.text());
      const j = await sttRes.json();
      const text = (j.transcript || "").trim();
      if (elTranscript) elTranscript.textContent = text || "(no speech)";

      if (text) await chatStream(text);
      else if (elRecState) elRecState.textContent = "idle";
    } catch {
      if (elTranscript) elTranscript.textContent = "";
      if (elReply) elReply.textContent = "Couldn’t transcribe. Try again.";
      if (elRecState) elRecState.textContent = "idle";
    } finally {
      try { micStream.getTracks().forEach(t => t.stop()); } catch {}
      micStream = null;
      mediaRecorder = null;
      mediaChunks = [];
    }
  };

  mediaRecorder.start(150);
}
function stopRecording() {
  if (mediaRecorder && isRecording) {
    try { mediaRecorder.stop(); } catch {}
  }
  if (elRecState) elRecState.textContent = "idle";
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result || "").split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ----------------------------- UI bindings -----------------------------
function getSelectedVoiceId() { return elVoiceSel?.value || ""; }

elSendBtn && elSendBtn.addEventListener("click", async () => {
  cancelSpeech();
  const text = (elTextIn?.value || "").trim();
  if (!text) return;
  elTextIn.value = "";
  await chatStream(text);
});

elSpeakBtn && elSpeakBtn.addEventListener("click", () => {
  const text = (elReply?.textContent || "").trim();
  if (text) {
    cancelSpeech();
    enqueueTTS(text, getSelectedVoiceId());
  }
});

if (elRecBtn) {
  elRecBtn.addEventListener("mousedown", startRecording);
  elRecBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); }, { passive: false });
  elRecBtn.addEventListener("mouseup", stopRecording);
  elRecBtn.addEventListener("mouseleave", stopRecording);
  elRecBtn.addEventListener("touchend", (e) => { e.preventDefault(); stopRecording(); }, { passive: false });
}

elTextIn && elTextIn.addEventListener("focus", cancelSpeech);
elTextIn && elTextIn.addEventListener("input", () => {
  if ((elTextIn.value || "").trim().length > 0) cancelSpeech();
});

window.addEventListener("beforeunload", () => {
  try { currentAbort?.abort(); } catch {}
  clearTTS("unload");
});
