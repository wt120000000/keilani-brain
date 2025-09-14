// public/assets/chat.js
// Single-voice streaming chat with ElevenLabs TTS (fallback to browser TTS optional)

const $ = (id) => document.getElementById(id);

/* ============================================================================
   CONFIG
============================================================================ */
const PREVIEW_BROWSER_TTS = false; // set true only if you want local preview TTS
const MIN_RECORD_MS = 700;         // minimum push-to-talk duration before STT
const STT_MIN_BYTES = 9500;        // tiny blobs are usually noise

/* ============================================================================
   GLOBAL STATE
============================================================================ */
const state = {
  lastReply: "",
  queueCursor: 0,
  playbackQueue: [],      // [{id, text, status}]
  interrupted: false,
  streamAbort: null,      // AbortController for SSE fetch
  mediaRecorder: null,
  chunks: [],
  dailyRoom: null,
  dailyUrl: null,
  meetingToken: null,
  voiceId: null,
};

let currentAudio = null;
let audioUnlocked = false;

/* ============================================================================
   AUDIO UNLOCK (mobile / autoplay)
============================================================================ */
async function unlockAudio() {
  if (audioUnlocked) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      await ctx.resume();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    }
  } catch {}
  audioUnlocked = true;
}
document.addEventListener("click", unlockAudio, { once: true });
document.addEventListener("touchstart", unlockAudio, { once: true });

/* ============================================================================
   BROWSER TTS (optional fallback) + CANCELLATION
============================================================================ */
function speakBrowser(text) {
  if (!PREVIEW_BROWSER_TTS) return; // hard-off by default
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1.0;
    u.volume = 1.0;
    speechSynthesis.speak(u);
  } catch {}
}
function cancelBrowserTTS() {
  try { window.speechSynthesis.cancel(); } catch {}
}

/* ============================================================================
   HARD STOP / INTERRUPT
============================================================================ */
function cancelPlayback() {
  // stop queue & SSE
  state.playbackQueue = [];
  state.queueCursor = 0;
  state.interrupted = true;

  try { if (state.streamAbort) state.streamAbort.abort(); } catch {}
  state.streamAbort = null;

  // stop browser TTS
  cancelBrowserTTS();

  // stop audio tags
  try {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = "";
      currentAudio.load?.();
      currentAudio = null;
    }
  } catch {}
  const p = $("ttsPlayer");
  if (p) { try { p.pause(); p.src = ""; p.load?.(); } catch {} }
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cancelPlayback(); });
$("stopSpeak")?.addEventListener("click", cancelPlayback);

/* ============================================================================
   UI HELPERS
============================================================================ */
function setBusy(btn, busy, idleText, busyText) {
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? busyText : idleText;
}

/* ============================================================================
   ELEVENLABS VOICES DROPDOWN
============================================================================ */
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
      sel.innerHTML = `<option value="">(no voices)</option>`;
      sel.disabled = true;
      state.voiceId = null;
    } else {
      if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
      state.voiceId = sel.value || null;
      sel.disabled = false;
      sel.onchange = () => {
        state.voiceId = sel.value || null;
        localStorage.setItem("voiceId", state.voiceId || "");
      };
    }
  } catch (e) {
    console.warn("voices unavailable:", e);
    sel.innerHTML = `<option value="">(voices unavailable)</option>`;
    sel.disabled = true;
    state.voiceId = null;
  }
})();

/* ============================================================================
   SENTENCE CHUNKING
============================================================================ */
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
    for (const s of sentences) {
      state.playbackQueue.push({ id: crypto.randomUUID(), text: s, status: "queued" });
    }
    processQueue();
  }
  state.queueCursor = nextCursor;
}

/* ============================================================================
   TTS HELPERS (ElevenLabs first; serialize playback)
============================================================================ */
async function ttsUrl(text) {
  try {
    const body = { text };
    if (state.voiceId) body.voiceId = state.voiceId;

    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      console.warn("TTS HTTP", r.status, msg.slice(0, 200));
      return "";
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("audio")) {
      console.warn("TTS content-type unexpected:", ct);
      return "";
    }
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  } catch (e) {
    console.warn("TTS fetch error:", e);
    return "";
  }
}

async function playAudioUrl(url) {
  return new Promise((resolve) => {
    cancelBrowserTTS();

    const visible = $("ttsPlayer");
    const a = new Audio();
    currentAudio = a;
    a.src = url;
    a.preload = "auto";

    const cleanup = () => {
      try { URL.revokeObjectURL(url); } catch {}
      resolve();
    };
    a.onended = cleanup;
    a.onerror = cleanup;

    if (visible) visible.src = url;

    a.play().catch(() => {
      // Autoplay blocked: try the visible player
      try { visible?.play?.(); } catch {}
      // resolve on ended/error
    });
  });
}

async function processQueue() {
  if (state.interrupted) return;
  while (state.playbackQueue.length) {
    if (state.interrupted) return;
    const item = state.playbackQueue.shift();
    if (!item) break;
    item.status = "speaking";

    // ElevenLabs first
    let url = "";
    try {
      url = await ttsUrl(item.text);
    } catch (e) {
      console.warn("TTS attempt failed:", e);
      url = "";
    }
    if (state.interrupted) return;

    if (url) {
      cancelBrowserTTS();
      await playAudioUrl(url); // serialize — wait until clip ends
    } else {
      // ElevenLabs unavailable; optional local fallback
      speakBrowser(item.text);
    }

    item.status = "done";
  }
}

/* ============================================================================
   STREAMING CHAT (SSE → live delta → sentence enqueue)
============================================================================ */
async function chatStream(message, onDelta) {
  const ac = new AbortController();
  state.streamAbort = ac;

  const res = await fetch("/api/chat-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal: ac.signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`chat-stream HTTP ${res.status} ${txt?.slice?.(0, 120) || ""}`);
  }
  if (!res.body) throw new Error("No stream body");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    const frames = buf.split("\n\n");
    buf = frames.pop() || "";

    for (const f of frames) {
      // format: "data: {json}"
      const line = f.trim();
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;

      let json = null;
      try { json = JSON.parse(raw); } catch { continue; }

      // OpenAI standard SSE shape
      const text =
        json?.choices?.[0]?.delta?.content ??
        json?.delta ??
        json?.text ??
        "";

      if (typeof text === "string" && text.length) onDelta(text);
    }
  }
}

/* ============================================================================
   STREAM DRIVER: userText -> SSE -> UI + TTS enqueue
============================================================================ */
async function chatStreamToTTS(userText) {
  let full = "";
  try {
    await chatStream(userText, (delta) => {
      if (state.interrupted) return;
      full += delta;
      $("reply").textContent = full;
      state.lastReply = full;
      enqueueSentences(full);
    });
  } finally {
    // flush remainder if no trailing punctuation
    const tail = full.slice(state.queueCursor).trim();
    if (tail) {
      state.playbackQueue.push({ id: crypto.randomUUID(), text: tail, status: "queued" });
      processQueue();
      state.queueCursor = full.length;
    }
    state.streamAbort = null;
  }
}

/* ============================================================================
   SEND (text)
============================================================================ */
$("sendText")?.addEventListener("click", async () => {
  const input = $("textIn");
  const text = (input?.value || "").trim();
  if (!text) return;

  cancelPlayback();
  cancelBrowserTTS();
  state.interrupted = false;
  state.queueCursor = 0;
  $("reply").textContent = "";
  input.value = "";

  try {
    await chatStreamToTTS(text);
  } catch (e) {
    console.error(e);
    $("reply").textContent = "⚠️ " + (e.message || "stream failed");
  }
});

/* ============================================================================
   SPEAK REPLY (re-synthesize full reply)
============================================================================ */
$("speakReply")?.addEventListener("click", async () => {
  const text = (state.lastReply || "").trim();
  if (!text) return;

  cancelPlayback();
  cancelBrowserTTS();
  state.interrupted = false;

  const btn = $("speakReply");
  setBusy(btn, true, "Speak Reply", "Speaking…");
  try {
    let url = "";
    try { url = await ttsUrl(text); } catch (e) { console.warn("TTS (speakReply) failed:", e); }
    if (url) {
      cancelBrowserTTS();
      await playAudioUrl(url);
    } else {
      speakBrowser(text);
    }
  } finally {
    setBusy(btn, false, "Speak Reply", "Speaking…");
  }
});

/* ============================================================================
   PUSH-TO-TALK (record -> /api/stt -> stream & speak)
============================================================================ */
function pickAudioMime() {
  const list = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const t of list) if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  return "";
}

const pttBtn = $("pttBtn");
if (pttBtn) {
  pttBtn.onmousedown  = startRecording;
  pttBtn.onmouseup    = stopRecording;
  pttBtn.ontouchstart = (e) => { e.preventDefault(); startRecording(); };
  pttBtn.ontouchend   = (e) => { e.preventDefault(); stopRecording(); };
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
    try {
      const blob = new Blob(state.chunks, { type: mimeType || "audio/webm" });
      const ms = Date.now() - startedAt;
      if (ms < MIN_RECORD_MS || blob.size < STT_MIN_BYTES) {
        $("transcript").textContent = "Hold to talk for ~1–2 seconds 👍";
        $("recState").textContent = "idle";
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const b64 = await new Promise((res) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.readAsDataURL(blob);
      });

      const sttR = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: b64 }),
      });
      if (!sttR.ok) {
        console.error("STT error:", await sttR.text());
        $("transcript").textContent = "Couldn’t transcribe. Try again.";
        $("recState").textContent = "idle";
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const stt = await sttR.json();
      $("transcript").textContent = stt.text || "";

      if ((stt.text || "").trim()) {
        cancelPlayback();
        cancelBrowserTTS();
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
    } catch (err) {
      console.error("PTT stop error:", err);
    } finally {
      $("recState").textContent = "idle";
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    }
  };

  state.mediaRecorder.start();
}
function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    try { state.mediaRecorder.stop(); } catch {}
  }
}

/* ============================================================================
   DAILY (RTC) – simple hooks
============================================================================ */
$("createRoom")?.addEventListener("click", async () => {
  const r = await fetch("/api/rtc/create-room", { method: "POST" });
  if (!r.ok) { console.error("create room error", await r.text()); return; }
  const j = await r.json();
  state.dailyRoom = j.room; state.dailyUrl = j.url;
  $("roomInfo").textContent = `Room: ${j.room}`;
});

let iframe;
$("openRoom")?.addEventListener("click", async () => {
  if (!state.dailyRoom) await $("createRoom").click();
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
});
$("closeRoom")?.addEventListener("click", () => { $("dailyMount").innerHTML = ""; iframe = null; });

/* ============================================================================
   AVATAR FEED (optional)
============================================================================ */
function feedAvatar(text) {
  $("avatarFeed")?.textContent = (text || "").slice(0, 1200);
}
