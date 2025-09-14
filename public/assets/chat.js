/* public/assets/chat.js
 * Keilani Brain — Live
 * - Push-to-talk → /api/stt
 * - Chat streaming (SSE) → /api/chat-stream
 * - ElevenLabs TTS → /api/tts
 * - Single audio element, bounded queue, de-dupe, and user interruption
 */

/* ------------------------------ DOM helpers ------------------------------ */
const $ = (id) => document.getElementById(id);

/* Expected elements in index.html:
  <textarea id="textIn"></textarea>
  <button   id="sendBtn"></button>
  <button   id="speakBtn"></button>
  <select   id="voiceSelect"></select>
  <div      id="reply"></div>
  <button   id="recBtn"></button>
  <span     id="recState"></span>
  <div      id="transcript"></div>
  <audio    id="ttsPlayer" controls></audio>
  <div      id="avatarFeed"></div>   (optional)
*/

/* --------------------------- Global conversation ------------------------- */
let currentAbort = null;           // Active SSE stream abort
let micStream = null;              // MediaStream
let mediaRecorder = null;          // MediaRecorder
let mediaChunks = [];              // Collected audio chunks
let isRecording = false;

/* ----------------------------- TTS Controller ---------------------------- */
const audioEl = $("ttsPlayer");
if (audioEl) audioEl.loop = false;

const TTS_MAX_QUEUE = 6;
let ttsQueue = [];
let speaking = false;
let ttsAbort = null;
const spokenSet = new Set(); // de-dupe short-term

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
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.currentTime = 0;
      if (audioEl.src) URL.revokeObjectURL(audioEl.src);
      audioEl.removeAttribute("src");
      audioEl.load();
    } catch {}
  }
  // console.debug("[tts] cleared:", reason);
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

    const blob = await res.blob(); // audio/mpeg
    const url = URL.createObjectURL(blob);

    audioEl.onended = () => {
      try { URL.revokeObjectURL(url); } catch {}
      speaking = false;
      ttsAbort = null;
      resetSpoken();
      playNext();
    };
    audioEl.onerror = () => {
      try { URL.revokeObjectURL(url); } catch {}
      speaking = false;
      ttsAbort = null;
      playNext();
    };

    audioEl.src = url;
    await audioEl.play().catch(() => {
      // user gesture not granted; leave loaded
    });
  } catch (err) {
    // console.warn("[tts] play failed:", err);
    speaking = false;
    ttsAbort = null;
    playNext();
  }
}

function enqueueTTS(text, voiceId) {
  const sentence = (text || "").trim();
  if (!sentence) return;
  const key = hash(sentence);
  if (spokenSet.has(key)) return;        // de-dupe
  spokenSet.add(key);

  if (ttsQueue.length >= TTS_MAX_QUEUE) ttsQueue.shift();
  ttsQueue.push({ text: sentence, voiceId });
  playNext();
}
function cancelSpeech() { clearTTS("interrupt"); }

/* ------------------------------ Avatar hook ------------------------------ */
function feedAvatar(text) {
  // Optional chaining can't be used on assignment. Do a safe lookup first.
  const el = $("avatarFeed");
  if (el) el.textContent = (text || "").slice(0, 1200);
}

/* ----------------------------- Chat streaming ---------------------------- */

const SENTENCE_BOUNDARY = /[.!?]\s$/;

// Parse SSE lines from fetch streaming response
async function streamSSE(url, body, { onOpen, onError, onPartial, onDone }) {
  currentAbort?.abort();
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

  // Consume text/event-stream manually
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  onOpen?.();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Split by event frames (double newline separates events)
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      // Extract event + data lines
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
      if (event === "open" || event === "ping") { /* keep-alive */ continue; }

      // OpenAI chunks: {choices:[{delta:{content:"..."}}]}
      try {
        const j = JSON.parse(data);
        const chunk = j?.choices?.[0]?.delta?.content ?? "";
        if (chunk) onPartial?.(chunk);
      } catch {
        // ignore parse errors
      }
    }
  }
}

/* Send a message, render partials, and speak sentence-by-sentence */
async function chatStream(userText) {
  cancelSpeech();            // stop any playing speech
  feedAvatar("");            // reset avatar feed
  $("reply").textContent = ""; // wipe UI
  let live = "";             // assembled text

  const voiceId = getSelectedVoiceId();

  function handlePartial(delta) {
    live += delta;
    $("reply").textContent = live;
    feedAvatar(live);

    // speak when we hit a boundary (de-duped by TTS controller)
    if (SENTENCE_BOUNDARY.test(live)) {
      enqueueTTS(live.trim(), voiceId);
      live = ""; // reset buffer for next sentence
    }
  }

  function handleDone() {
    // If we ended mid-sentence, speak the remainder once
    const tail = live.trim();
    if (tail) enqueueTTS(tail, voiceId);
  }

  function handleError(e) {
    const msg = e?.error || e?.text || "stream error";
    $("reply").textContent = `⚠ ${msg}`;
  }

  try {
    await streamSSE("/api/chat-stream", { message: userText }, {
      onOpen() { /* UI could show "streaming…" */ },
      onPartial: handlePartial,
      onDone: handleDone,
      onError: handleError,
    });
  } catch (err) {
    $("reply").textContent = `⚠ ${String(err).slice(0, 240)}`;
  } finally {
    currentAbort = null;
  }
}

/* ------------------------------ STT (mic) -------------------------------- */

async function startRecording() {
  cancelSpeech(); // user is talking → stop playback
  if (isRecording) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    $("recState").textContent = "mic denied";
    return;
  }

  $("recState").textContent = "recording…";
  mediaChunks = [];
  mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
  isRecording = true;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) mediaChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    isRecording = false;
    $("recState").textContent = "processing…";
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
      $("transcript").textContent = text || "(no speech)";

      if (text) await chatStream(text);
      else $("recState").textContent = "idle";
    } catch (err) {
      $("transcript").textContent = "";
      $("reply").textContent = "Couldn’t transcribe. Try again.";
      $("recState").textContent = "idle";
    } finally {
      try { micStream.getTracks().forEach(t => t.stop()); } catch {}
      micStream = null;
      mediaRecorder = null;
      mediaChunks = [];
    }
  };

  mediaRecorder.start(150); // small timeslice improves onstop availability
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    try { mediaRecorder.stop(); } catch {}
  }
  $("recState").textContent = "idle";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result || "";
      resolve(String(res).split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/* ------------------------------- UI wiring ------------------------------- */

function getSelectedVoiceId() {
  return $("voiceSelect")?.value || "";
}

$("sendBtn")?.addEventListener("click", async () => {
  cancelSpeech();
  const text = ($("textIn")?.value || "").trim();
  if (!text) return;
  $("textIn").value = "";
  await chatStream(text);
});

$("speakBtn")?.addEventListener("click", () => {
  const text = ($("reply")?.textContent || "").trim();
  if (text) {
    cancelSpeech();
    enqueueTTS(text, getSelectedVoiceId());
  }
});

// PTT: hold to talk
$("recBtn")?.addEventListener("mousedown", startRecording);
$("recBtn")?.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); }, { passive: false });
$("recBtn")?.addEventListener("mouseup", stopRecording);
$("recBtn")?.addEventListener("mouseleave", stopRecording);
$("recBtn")?.addEventListener("touchend", (e) => { e.preventDefault(); stopRecording(); }, { passive: false });

// Interrupt speech whenever user types or focuses the input
$("textIn")?.addEventListener("focus", cancelSpeech);
$("textIn")?.addEventListener("input", () => {
  if (($("textIn").value || "").trim().length > 0) cancelSpeech();
});

// Cancel any active stream when navigating away
window.addEventListener("beforeunload", () => {
  try { currentAbort?.abort(); } catch {}
  clearTTS("unload");
});
