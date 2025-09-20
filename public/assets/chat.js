// public/assets/chat.js
// Keilani Brain — Live Chat Frontend

// === DOM Elements ===
const btnRecord = document.getElementById("btnRecord");
const btnStop = document.getElementById("btnStop");
const btnSpeakTest = document.getElementById("btnSpeakTest");

let mediaRecorder, audioChunks = [];
let loopMode = false;

// === Logging Helper ===
function log(...args) {
  console.log("[CHAT]", ...args);
}

// === TTS: play audio from backend ===
async function speak(text, opts = {}) {
  log("speak()", text, opts);
  try {
    const res = await fetch("/.netlify/functions/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...opts }),
    });
    if (!res.ok) throw new Error(await res.text());
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    await audio.play();
    log("[CHAT] TTS played", buf.byteLength, "bytes");
  } catch (err) {
    console.error("[CHAT] TTS failed", err);
  }
}

// === Ask LLM (chat backend) ===
async function askLLM(text) {
  log("askLLM sending:", text);

  // Filler line with timeout so it feels natural
  let fillerTimeout = setTimeout(() => {
    speak("Gimme a sec...", { speed: 1.1 });
  }, 600);

  try {
    const res = await fetch("/.netlify/functions/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "global", message: text }),
    });

    clearTimeout(fillerTimeout);

    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    log("CHAT status", res.status, data);

    if (data.reply) {
      await speak(data.reply, { emotion: data.next_emotion_state || {} });
    }
  } catch (err) {
    clearTimeout(fillerTimeout);
    console.error("[CHAT] askLLM failed", err);
  }
}

// === STT Transcribe Blob ===
async function transcribe(blob) {
  log("sending audio blob", blob.size, "bytes");
  const formData = new FormData();
  formData.append("file", blob, "speech.webm");

  const res = await fetch("/.netlify/functions/stt", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  log("STT status", res.status, data);
  if (data.transcript) {
    log("TRANSCRIPT:", data.transcript);
    await askLLM(data.transcript);
  }
}

// === Recorder Handling ===
async function startRecording() {
  log("record click → loopMode ON");
  loopMode = true;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  audioChunks = [];

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data);
    }
  });

  mediaRecorder.addEventListener("stop", async () => {
    const blob = new Blob(audioChunks, { type: "audio/webm;codecs=opus" });
    log("recording stopped", blob.size, "bytes");
    await transcribe(blob);
    if (loopMode) {
      startRecording(); // auto restart
    }
  });

  mediaRecorder.start();
  log("recording started with", mediaRecorder.mimeType);
}

function stopRecording() {
  log("stopRecording()");
  loopMode = false;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

// === UI Bindings ===
document.addEventListener("DOMContentLoaded", () => {
  log("DOMContentLoaded; wiring handlers");
  if (btnRecord) btnRecord.addEventListener("click", startRecording);
  if (btnStop) btnStop.addEventListener("click", stopRecording);
  if (btnSpeakTest) btnSpeakTest.addEventListener("click", () => {
    speak("Hi, I’m Keilani. Testing one, two, three.");
  });
});
