// public/assets/chat.js
// Main client-side driver for Keilani Brain

console.log("[CHAT] DOMContentLoaded; wiring handlers");

const $log = (msg, ...args) => console.log("[CHAT]", msg, ...args);
const apiBase = window.location.origin.includes("localhost")
  ? "http://localhost:8888/.netlify/functions"
  : "/.netlify/functions";

// === DOM elements ===
const btnRecord = document.getElementById("btn-record");
const btnStop = document.getElementById("btn-stop");
const btnTest = document.getElementById("btn-test");
const outBox = document.getElementById("output");

let mediaRecorder;
let audioChunks = [];
let loopMode = false;

// Utility: append to output log
function logLine(txt, color = "white") {
  const p = document.createElement("pre");
  p.style.color = color;
  p.textContent = txt;
  outBox.appendChild(p);
  outBox.scrollTop = outBox.scrollHeight;
}

// Clamp helper
function clamp01(v, fallback = 0.5) {
  const n = parseFloat(v);
  if (isNaN(n)) return fallback;
  return Math.max(0.0, Math.min(1.0, n));
}

// === Recording ===
async function startRecording() {
  $log("record click → loopMode", loopMode ? "ON" : "OFF");

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

  audioChunks = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: "audio/webm;codecs=opus" });
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    $log("final blob audio/webm;codecs=opus", blob.size, "bytes");

    await sttAndChat(base64, blob.size);

    if (loopMode) {
      setTimeout(startRecording, 100);
    }
  };

  mediaRecorder.start();
  $log("recording started with audio/webm;codecs=opus (VAD, fast)");

  setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      $log("recording stopped (max)");
    }
  }, 5000);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    $log("recording stopped (manual)");
  }
}

// === STT + Chat + TTS ===
async function sttAndChat(base64, bytes) {
  try {
    // Step 1: STT
    const sttResp = await fetch(`${apiBase}/stt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: base64, mime: "audio/webm", bytes }),
    });
    const sttJson = await sttResp.json();
    $log("STT status", sttResp.status, sttJson);

    if (!sttResp.ok || !sttJson.transcript) {
      logLine("STT failed", "red");
      return;
    }
    const transcript = sttJson.transcript;
    logLine(`TRANSCRIPT: ${transcript}`, "cyan");

    // Step 2: Chat
    const chatResp = await fetch(`${apiBase}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "global", message: transcript }),
    });
    const chatJson = await chatResp.json();
    $log("CHAT status", chatResp.status, chatJson);

    if (!chatResp.ok || !chatJson.reply) {
      logLine("CHAT failed", "red");
      return;
    }
    const reply = chatJson.reply;
    logLine(`Keilani: ${reply}`, "magenta");

    // Step 3: TTS
    // Normalize emotion values before sending
    const emotion = {
      stability: clamp01(chatJson.emotion?.stability ?? 0.5),
      similarity: clamp01(chatJson.emotion?.similarity ?? 0.75),
      style: clamp01(chatJson.emotion?.style ?? 0.5),
    };

    const ttsResp = await fetch(`${apiBase}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: reply, emotion }),
    });

    if (!ttsResp.ok) {
      const err = await ttsResp.text();
      logLine("TTS failed " + ttsResp.status + ": " + err, "red");
      return;
    }

    const ttsArrayBuf = await ttsResp.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await audioCtx.decodeAudioData(ttsArrayBuf);
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(audioCtx.destination);
    src.start();
    $log("TTS played", ttsArrayBuf.byteLength, "bytes");
  } catch (err) {
    logLine("STT/CHAT/TTS failed " + err.message, "red");
    $log("Error:", err);
  }
}

// === Buttons ===
btnRecord.addEventListener("click", () => {
  loopMode = true;
  startRecording();
});

btnStop.addEventListener("click", () => {
  loopMode = false;
  stopRecording();
});

btnTest.addEventListener("click", async () => {
  await sttAndChat(null, 0); // Quick trigger
});
