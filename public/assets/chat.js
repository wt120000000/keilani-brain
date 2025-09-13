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
  playbackQueue: [],      // [{ id, text, status: 'queued'|'speaking'|'done', hqUrl? }]
  queueCursor: 0,
  interrupted: false,
};

// ---------------- Audio: unlock, play, stop (user interruption) ----------------
let audioUnlocked = false;
let currentAudio = null;

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
  state.playbackQueue = [];
  state.queueCursor = 0;
  state.interrupted = true;
  try { speechSynthesis.cancel(); } catch {}
  try { if (currentAudio) { currentAudio.pause(); currentAudio.src = ""; currentAudio = null; } } catch {}
  const p = $("ttsPlayer");
  if (p) { try { p.pause(); p.src = ""; } catch {} }
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cancelPlayback(); });
const stopBtn = $("stopSpeak");
if (stopBtn) stopBtn.onclick = cancelPlayback;

async function playAudioUrl(url) {
  // Try programmatic audio; fall back to visible player if blocked
  try {
    const a = new Audio();
    currentAudio = a;
    a.src = url;
    a.autoplay = true;
    a.onended = () => URL.revokeObjectURL(url);
    await a.play();
    $("ttsPlayer").src = url; // mirror to UI
  } catch (e) {
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
  // return { sentences: [...], nextCursor }
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

async function processQueue() {
  if (state.interrupted) return;
  // If something is currently speaking (SpeechSynthesis queue or currentAudio), we still proceed sentence by sentence:
  while (state.playbackQueue.length) {
    if (state.interrupted) return;
    const item = state.playbackQueue.shift();
    if (!item) break;
    item.status = "speaking";

    // 1) instant fill
    speakBrowser(item.text);

    // 2) upgrade to HQ as soon as we get MP3
    try {
      const url = await tts(item.text);
      if (state.interrupted) return;
      if (url) await playAudioUrl(url);
    } catch (e) {
      console.warn("TTS upgrade failed:", e);
    }

    item.status = "done";
  }
}

// ---------------- Text chat (streaming) ----------------
$("sendText").onclick = async () => {
  const input = $("textIn");
  const userText = input.value.trim();
  if (!userText) return;

  cancelPlayback();                   // allow interruption of prior speech
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
    // speak entire last reply as-is
    speakBrowser(state.lastReply);
    const url = await tts(state.lastReply);
    if (url) await playAudioUrl(url);
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
  // at stream end: flush trailing sentence if any (no punctuation)
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

// ---------------- API helpers ----------------
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
