// public/assets/chat.js
// Stream text replies via SSE and speak them with ElevenLabs (fallback to browser TTS).

/* ----------------------- DOM shortcuts & shared state ---------------------- */
const $ = (id) => document.getElementById(id);

const state = {
  lastReply: "",
  voiceId: null,
  queueCursor: 0,
  playbackQueue: [],         // [{id, text, status}]
  interrupted: false,
  streamAbort: null,
  mediaRecorder: null,
  chunks: []
};

// Turn this OFF to avoid mixed voices. If ElevenLabs fails, we still fall back to browser TTS.
const PREVIEW_BROWSER_TTS = false;

let currentAudio = null;
let audioUnlocked = false;

/* ------------------------------ Audio unlock ------------------------------- */
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

/* --------------------------- Interrupt / Stop all -------------------------- */
function cancelPlayback() {
  // Stop queue & streaming TTS
  state.playbackQueue = [];
  state.queueCursor = 0;
  state.interrupted = true;
  try { if (state.streamAbort) state.streamAbort.abort(); } catch {}
  state.streamAbort = null;

  // Stop Web Speech
  try { window.speechSynthesis.cancel(); } catch {}

  // Stop <audio>
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
const stopBtn = $("stopSpeak"); if (stopBtn) stopBtn.onclick = cancelPlayback;

/* --------------------------- Small UI conveniences ------------------------- */
function setBusy(btn, busy, idleText, busyText) {
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? busyText : idleText;
}

/* --------------------------- Voice select (top 5) -------------------------- */
(async function initVoices() {
  const sel = $("voiceSelect");
  if (!sel) return;
  sel.disabled = true; sel.innerHTML = `<option>Loading voices…</option>`;
  const saved = localStorage.getItem("voiceId") || "";

  try {
    const r = await fetch("/api/voices");
    if (!r.ok) throw new Error(await r.text());
    const { voices } = await r.json();
    sel.innerHTML = "";
    (voices || []).slice(0,5).forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.voice_id;
      opt.textContent = `${v.name} (${v.voice_id.slice(0,6)}…)`;
      sel.appendChild(opt);
    });
    if (!sel.options.length) {
      sel.innerHTML = `<option value="">(no voices)</option>`;
      sel.disabled = true; state.voiceId = null;
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
    console.warn("voices unavailable:", e);
    sel.innerHTML = `<option value="">(voices unavailable)</option>`;
    sel.disabled = true;
    state.voiceId = null;
  }
})();

/* ---------------------------- Browser TTS (fast) --------------------------- */
function speakBrowser(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
    speechSynthesis.speak(u);
  } catch {}
}

/* ------------------------- Sentence chunking utils ------------------------- */
function extractNewSentences(fullText, cursor) {
  const re = /[^.!?]+[.!?]+(\s+|$)/g;
  re.lastIndex = cursor;
  const out = []; let m;
  while ((m = re.exec(fullText))) out.push(m[0].trim());
  return { sentences: out, nextCursor: re.lastIndex };
}
async function enqueueSentences(text) {
  const { sentences, nextCursor } = extractNewSentences(text, state.queueCursor);
  if (sentences.length) {
    for (const s of sentences) state.playbackQueue.push({ id: crypto.randomUUID(), text: s, status: "queued" });
    processQueue();
  }
  state.queueCursor = nextCursor;
}

/* ------------------------------- TTS helpers ------------------------------- */
async function playAudioUrl(url) {
  const el = $("ttsPlayer");
  try {
    const a = new Audio();
    currentAudio = a;
    a.src = url; a.autoplay = true;
    a.onended = () => URL.revokeObjectURL(url);
    await a.play().catch(() => {});   // if blocked, visible control below can play
    el.src = url;                     // mirror to visible player
  } catch {
    el.src = url;
  }
}

/** POST /api/tts and return a blob URL (or "" on failure).  */
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
      // Common failure you reported: 404 when function/redirect not live
      const msg = await r.text().catch(() => "");
      console.warn("TTS HTTP", r.status, msg.slice(0,200));
      return "";
    }
    // content-type should be audio/mpeg
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

/* --------- Streaming ElevenLabs via MSE (best) with fallback to MP3 -------- */
async function playTTSStreamMSE(text) {
  // If you haven't wired a streaming TTS endpoint yet, skip to MP3 fallback:
  throw new Error("streaming-tts-not-configured");
}

/* --------------------------- Playback queue driver ------------------------- */
async function processQueue() {
  if (state.interrupted) return;
  while (state.playbackQueue.length) {
    if (state.interrupted) return;
    const item = state.playbackQueue.shift();
    if (!item) break;
    item.status = "speaking";

    // Try ElevenLabs first (streaming not wired yet, so REST MP3)
    let url = "";
    try {
      // If/when MSE streaming is implemented, call it here first.
      // await playTTSStreamMSE(item.text);
      url = await ttsUrl(item.text);
    } catch (e) {
      console.warn("TTS attempt failed:", e);
      url = "";
    }

    if (state.interrupted) return;

    if (url) {
      // We got ElevenLabs audio -> make sure browser TTS is not also speaking
      try { window.speechSynthesis.cancel(); } catch {}
      await playAudioUrl(url);
    } else {
      // ElevenLabs not available; optionally fall back to browser TTS
      if (PREVIEW_BROWSER_TTS) speakBrowser(item.text);
    }

    item.status = "done";
  }
}

/* --------------------------- Streaming chat (SSE) -------------------------- */
async function chatStream(message, onDelta) {
  try {
    const res = await fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("chat-stream HTTP error", res.status, txt);
      throw new Error(`chat-stream HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("no-body");

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
        if (!f.startsWith("data:")) continue;
        const json = f.slice(5).trim();
        if (!json) continue;
        const msg = JSON.parse(json);
        if (msg.type === "delta" && msg.delta) onDelta(msg.delta);
      }
    }
  } catch (e) {
    // Fallback to non-streaming so UI still works
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!r.ok) throw new Error(`chat fallback ${r.status}`);
    const j = await r.json();
    onDelta(j.reply || "");
  }
}

/* ------------------- Stream → sentence enqueue → speak --------------------- */
async function chatStreamToTTS(userText) {
  let full = "";
  await chatStream(userText, (delta) => {
    if (state.interrupted) return;
    full += delta;
    $("reply").textContent = full;
    state.lastReply = full;
    enqueueSentences(full);
  });
  // flush last fragment (no punctuation)
  const tail = full.slice(state.queueCursor).trim();
  if (tail) {
    state.playbackQueue.push({ id: crypto.randomUUID(), text: tail, status: "queued" });
    processQueue();
    state.queueCursor = full.length;
  }
}

/* --------------------------------- Send ----------------------------------- */
$("sendText").onclick = async () => {
  const input = $("textIn");
  const text = (input.value || "").trim();
  if (!text) return;

  cancelPlayback();
  state.interrupted = false;
  state.queueCursor = 0;
  $("reply").textContent = "";
  input.value = "";

  try { await chatStreamToTTS(text); }
  catch (e) { console.error(e); $("reply").textContent = "⚠️ " + (e.message || "stream failed"); }
};

$("speakReply").onclick = async () => {
  const text = state.lastReply.trim();
  if (!text) return;
  cancelPlayback();
  state.interrupted = false;
  const btn = $("speakReply");
  setBusy(btn, true, "Speak Reply", "Speaking…");
  try {
    let url = "";
    try {
      url = await ttsUrl(text);
    } catch (e) {
      console.warn("TTS (speakReply) failed:", e);
      url = "";
    }

    if (url) {
      try { window.speechSynthesis.cancel(); } catch {}
      await playAudioUrl(url);
    } else if (PREVIEW_BROWSER_TTS) {
      speakBrowser(text);
    }
  } finally {
    setBusy(btn, false, "Speak Reply", "Speaking…");
  }
};

/* ----------------------------- Push-to-talk (STT) -------------------------- */
function pickAudioMime() {
  const list = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const t of list) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return "";
}

const pttBtn = $("pttBtn");
if (pttBtn) {
  pttBtn.onmousedown = startRecording;
  pttBtn.onmouseup = stopRecording;
  pttBtn.ontouchstart = (e) => { e.preventDefault(); startRecording(); };
  pttBtn.ontouchend = (e) => { e.preventDefault(); stopRecording(); };
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
      if (ms < 600 || blob.size < 9000) {
        $("transcript").textContent = "Hold the button and speak for ~1–2 seconds 👍";
        $("recState").textContent = "idle";
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      const b64 = await new Promise((res) => {
        const r = new FileReader(); r.onloadend = () => res(r.result); r.readAsDataURL(blob);
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
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const stt = await sttR.json();
      $("transcript").textContent = stt.text || "";

      if (stt.text) {
        cancelPlayback();
        state.interrupted = false;
        state.queueCursor = 0;
        $("reply").textContent = "";
        try { await chatStreamToTTS(stt.text); }
        catch (e) { console.error(e); $("reply").textContent = "⚠️ " + (e.message || "stream failed"); }
      }
    } catch (err) {
      console.error("PTT stop error:", err);
    } finally {
      $("recState").textContent = "idle";
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
    }
  };
  state.mediaRecorder.start();
}
function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    try { state.mediaRecorder.stop(); } catch {}
  }
}

/* ------------------------------ Daily (RTC) ------------------------------- */
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

/* ----------------------------- Avatar hook demo ---------------------------- */
function feedAvatar(text) { $("avatarFeed").textContent = (text || "").slice(0, 1200); }
