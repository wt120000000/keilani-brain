// public/assets/chat.js

// ---------------- DOM helpers & state ----------------
const $ = (id) => document.getElementById(id);
const state = {
  mediaRecorder: null,
  chunks: [],
  dailyRoom: null,
  dailyUrl: null,
  meetingToken: null,
  lastReply: "",
  voiceId: null,          // ElevenLabs voice (persisted)
  playbackQueue: [],      // [{ id, text, status: 'queued'|'speaking'|'done' }]
  queueCursor: 0,
  interrupted: false,
  streamAbort: null,      // AbortController for streaming TTS
};

let currentAudio = null;

// ---------------- Audio: unlock, play, stop (user interruption) ----------------
let audioUnlocked = false;
async function unlockAudio() {
  if (audioUnlocked) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      await ctx.resume();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start(0);
    }
  } catch {}
  audioUnlocked = true;
}
document.addEventListener("click", unlockAudio, { once: true });
document.addEventListener("touchstart", unlockAudio, { once: true });

function cancelPlayback() {
  // stop queues
  state.playbackQueue = [];
  state.queueCursor = 0;
  state.interrupted = true;

  // stop streaming TTS if running
  try { if (state.streamAbort) state.streamAbort.abort(); } catch {}
  state.streamAbort = null;

  // stop browser speech
  try { speechSynthesis.cancel(); } catch {}

  // stop current audio element(s)
  try { if (currentAudio) { currentAudio.pause(); currentAudio.src = ""; currentAudio = null; } } catch {}
  const p = $("ttsPlayer");
  if (p) { try { p.pause(); p.src = ""; } catch {} }
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cancelPlayback(); });
const stopBtn = $("stopSpeak");
if (stopBtn) stopBtn.onclick = cancelPlayback;

// non-stream fallback (for MP3 URLs we build client-side)
async function playAudioUrl(url) {
  try {
    const a = new Audio();
    currentAudio = a;
    a.src = url;
    a.autoplay = true;
    a.onended = () => URL.revokeObjectURL(url);
    await a.play().catch(() => {});   // browser may block; visible player will handle
    $("ttsPlayer").src = url;         // mirror to visible control
  } catch {
    $("ttsPlayer").src = url;
  }
}

// ---------------- Buttons: busy / enabled helpers ----------------
function setBusy(btn, busy, labelIdle, labelBusy) {
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? labelBusy : labelIdle;
}

// ---------------- Voice selector (dynamic; remembers last choice) ----------------
(async function initVoices() {
  const sel = $("voiceSelect");
  if (!sel) return;

  sel.disabled = true;
  sel.innerHTML = `<option>Loading voices…</option>`;

  const saved = localStorage.getItem("voiceId") || "";

  try {
    const r = await fetch("/api/voices");
    if (!r.ok) throw new Error(await r.text());
    const { voices } = await r.json();

    sel.innerHTML = "";
    (voices || []).slice(0, 5).forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.voice_id;
      opt.textContent = `${v.name} (${v.voice_id.slice(0, 6)}…)`;
      sel.appendChild(opt);
    });

    if (!sel.options.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No voices available";
      sel.appendChild(opt);
      sel.disabled = true;
      state.voiceId = null;
    } else {
      if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
      state.voiceId = sel.value || null;
      sel.disabled = false;
      sel.onchange = () => {
        state.voiceId = sel.value || null;
        localStorage.setItem("voiceId", state.voiceId || "");
      };
    }
  } catch (e) {
    console.error("voices load failed:", e);
    sel.innerHTML = `<option value="">(voices unavailable)</option>`;
    sel.disabled = true;
    state.voiceId = null;
  }
})();

// ---------------- Browser TTS (instant preview) ----------------
function speakBrowser(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
    speechSynthesis.speak(u);
  } catch {}
}

// ---------------- Sentence chunking & queue ----------------
function extractNewSentences(fullText, cursor) {
  const re = /[^.!?]+[.!?]+(\s+|$)/g;
  re.lastIndex = cursor;
  const out = [];
  let m;
  while ((m = re.exec(fullText))) out.push(m[0].trim());
  return { sentences: out, nextCursor: re.lastIndex };
}

async function enqueueSentences(text) {
  const { sentences, nextCursor } = extractNewSentences(text, state.queueCursor);
  if (sentences.length) {
    sentences.forEach((s) => {
      state.playbackQueue.push({ id: crypto.randomUUID(), text: s, status: "queued" });
    });
    processQueue(); // fire-and-forget
  }
  state.queueCursor = nextCursor;
}

// --- Streaming TTS via MediaSource (audio starts while bytes arrive) ---
async function playTTSStreamMSE(text) {
  if (!text) return;
  const controller = new AbortController();
  state.streamAbort = controller;

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  const audioEl = $("ttsPlayer");
  audioEl.src = objectUrl;

  await audioEl.play().catch(() => { /* if blocked, user can press play */ });

  return new Promise((resolve, reject) => {
    mediaSource.addEventListener("sourceopen", async () => {
      let sb;
      try {
        sb = mediaSource.addSourceBuffer("audio/mpeg");
      } catch (e) {
        reject(new Error("MediaSource unsupported for audio/mpeg"));
        return;
      }

      const queue = [];
      sb.addEventListener("updateend", () => {
        if (controller.signal.aborted) {
          try { mediaSource.endOfStream(); } catch {}
          URL.revokeObjectURL(objectUrl);
          resolve();
          return;
        }
        if (!sb.updating && queue.length) sb.appendBuffer(queue.shift());
      });

      try {
        const res = await fetch("/api/tts-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId: state.voiceId || null, latency: 2 }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(await res.text());

        const reader = res.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done || controller.signal.aborted) break;
          if (!sb.updating && queue.length === 0) {
            sb.appendBuffer(value);
          } else {
            queue.push(value);
          }
        }
      } catch (err) {
        reject(err);
        return;
      } finally {
        if (!controller.signal.aborted) {
          try { mediaSource.endOfStream(); } catch {}
          URL.revokeObjectURL(objectUrl);
          resolve();
        }
      }
    }, { once: true });
  });
}

async function processQueue() {
  if (state.interrupted) return;
  while (state.playbackQueue.length) {
    if (state.interrupted) return;
    const item = state.playbackQueue.shift();
    if (!item) break;
    item.status = "speaking";

    // 1) instant fill (zero-latency preview)
    speakBrowser(item.text);

    // 2b) STREAMING HQ: start playing as bytes arrive; fallback to MP3 if needed
    try {
      await playTTSStreamMSE(item.text);           // near-instant HQ stream
    } catch (e) {
      console.warn("Streaming TTS failed; falling back to MP3:", e);
      try {
        const url = await tts(item.text);
        if (state.interrupted) return;
        if (url) await playAudioUrl(url);
      } catch (e2) {
        console.warn("TTS MP3 fallback failed:", e2);
      }
    }

    item.status = "done";
  }
}

// ---------------- Text chat (streaming) ----------------
$("sendText").onclick = async () => {
  const input = $("textIn");
  const userText = input.value.trim();
  if (!userText) return;

  cancelPlayback();                   // stop any prior speech
  state.interrupted = false;
  state.queueCursor = 0;
  $("reply").textContent = "";
  input.value = "";

  try {
    await chatStreamToTTS(userText);  // stream + speak sentence-by-sentence
  } catch (e) {
    console.error(e);
    $("reply").textContent = "⚠️ " + (e.message || "stream failed");
  }
};

$("speakReply").onclick = async () => {
  if (!state.lastReply) return;
  cancelPlayback();
  state.interrupted = false;
  const btn = $("speakReply");
  setBusy(btn, true, "Speak Reply", "Speaking…");
  try {
    // speak entire last reply
    speakBrowser(state.lastReply);
    // prefer streaming even for whole reply
    try {
      await playTTSStreamMSE(state.lastReply);
    } catch {
      const url = await tts(state.lastReply);
      if (url) await playAudioUrl(url);
    }
  } finally {
    setBusy(btn, false, "Speak Reply", "Speaking…");
  }
};

// stream helper: reads SSE from /api/chat-stream
async function chatStream(message, onDelta) {
  const res = await fetch("/api/chat-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) throw new Error("stream failed");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      if (!frame.startsWith("data:")) continue;
      const json = frame.slice(5).trim();
      if (!json) continue;
      const msg = JSON.parse(json);
      if (msg.type === "delta" && msg.delta) onDelta(msg.delta);
    }
  }
}

// stream + sentence-to-TTS pipeline
async function chatStreamToTTS(userText) {
  let full = "";
  await chatStream(userText, (delta) => {
    if (state.interrupted) return;
    full += delta;
    $("reply").textContent = full;
    state.lastReply = full;          // keep updated for “Speak Reply”
    enqueueSentences(full);
  });
  // flush trailing fragment (no punctuation)
  const tail = full.slice(state.queueCursor).trim();
  if (tail) {
    state.playbackQueue.push({ id: crypto.randomUUID(), text: tail, status: "queued" });
    processQueue();
    state.queueCursor = full.length;
  }
}

// ---------------- Push-to-talk (reliable recorder) ----------------
const pttBtn = $("pttBtn");
if (pttBtn) {
  pttBtn.onmousedown = startRecording;
  pttBtn.onmouseup = stopRecording;
  pttBtn.ontouchstart = (e) => { e.preventDefault(); startRecording(); };
  pttBtn.ontouchend = (e) => { e.preventDefault(); stopRecording(); };
}

function pickAudioMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function startRecording() {
  $("recState").textContent = "recording…";
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
  });

  state.chunks = [];
  const mimeType = pickAudioMime();
  state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  const startedAt = Date.now();

  state.mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };

  state.mediaRecorder.onstop = async () => {
    $("recState").textContent = "processing…";
    const blob = new Blob(state.chunks, { type: mimeType || "audio/webm" });
    const ms = Date.now() - startedAt;

    if (ms < 600 || blob.size < 9000) {
      $("transcript").textContent = "Hold the button and speak for ~1–2 seconds 👍";
      $("recState").textContent = "idle";
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      return;
    }

    const b64 = await blobToBase64(blob);

    const sttResp = await fetch("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: b64 }),
    });

    if (!sttResp.ok) {
      console.error("STT error:", await sttResp.text());
      $("transcript").textContent = "Couldn’t transcribe. Try again.";
      $("recState").textContent = "idle";
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      return;
    }

    const stt = await sttResp.json();
    $("transcript").textContent = stt.text || "";

    if (stt.text) {
      cancelPlayback();
      state.interrupted = false;
      state.queueCursor = 0;
      $("reply").textContent = "";
      try {
        await chatStreamToTTS(stt.text);
      } catch (e) {
        console.error(e);
        $("reply").textContent = "⚠️ " + (e.message || "stream failed");
      }
    }

    $("recState").textContent = "idle";
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
  };

  state.mediaRecorder.start();
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
}

function blobToBase64(blob) {
  return new Promise((res) => { const r = new FileReader(); r.onloadend = () => res(r.result); r.readAsDataURL(blob); });
}

// ---------------- API helper (non-stream fallback MP3) ----------------
async function tts(text) {
  if (!text) return "";
  const body = { text };
  if (state.voiceId) body.voiceId = state.voiceId;

  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error("TTS error", await r.text()); return ""; }
  const blob = await r.blob();
  return URL.createObjectURL(blob);
}

// ---------------- Daily room (camera / screen share) ----------------
$("createRoom").onclick = async () => {
  const r = await fetch("/api/rtc/create-room", { method: "POST" });
  if (!r.ok) { console.error("create room error", await r.text()); return; }
  const j = await r.json();
  state.dailyRoom = j.room; state.dailyUrl = j.url;
  $("roomInfo").textContent = `Room: ${j.room}`;
};

let iframe;
$("openRoom").onclick = async () => {
  if (!state.dailyRoom) await $("createRoom").onclick();
  const tokenRes = await fetch("/api/rtc/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: state.dailyRoom, userName: "Guest" }),
  });
  const tokenJson = tokenRes.ok ? await tokenRes.json() : {};
  state.meetingToken = tokenJson.token;

  const mount = $("dailyMount");
  mount.innerHTML = "";
  iframe = document.createElement("iframe");
  const url = new URL(state.dailyUrl);
  if (state.meetingToken) url.searchParams.set("t", state.meetingToken);
  iframe.src = url.toString();
  iframe.allow = "camera; microphone; display-capture";
  iframe.style.width = "100%"; iframe.style.height = "540px";
  iframe.style.border = "0"; iframe.style.borderRadius = "12px";
  mount.appendChild(iframe);
};

$("closeRoom").onclick = () => { $("dailyMount").innerHTML = ""; iframe = null; };

// ---------------- Avatar hook (future lip-sync) ----------------
function feedAvatar(text) { $("avatarFeed").textContent = (text || "").slice(0, 1200); }
