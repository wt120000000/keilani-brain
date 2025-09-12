// public/assets/chat.js

// ------------- DOM helpers & state -------------
const $ = (id) => document.getElementById(id);
const state = {
  mediaRecorder: null,
  chunks: [],
  dailyRoom: null,
  dailyUrl: null,
  meetingToken: null,
  lastReply: "",
};

// ------------- TEXT CHAT -------------
$("sendText").onclick = async () => {
  const message = $("textIn").value.trim();
  if (!message) return;
  const reply = await chat(message);
  $("reply").textContent = reply;
  state.lastReply = reply;
  feedAvatar(reply);
};

$("speakReply").onclick = async () => {
  if (!state.lastReply) return;
  const audioUrl = await tts(state.lastReply);
  if (audioUrl) {
    const player = $("ttsPlayer");
    player.src = audioUrl;
    player.play();
  }
};

// ------------- PUSH-TO-TALK (reliable recorder) -------------
const pttBtn = $("pttBtn");
pttBtn.onmousedown = startRecording;
pttBtn.onmouseup = stopRecording;
pttBtn.ontouchstart = (e) => { e.preventDefault(); startRecording(); };
pttBtn.ontouchend = (e) => { e.preventDefault(); stopRecording(); };

// Choose the best-supported audio mime for speech
function pickAudioMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return ""; // browser will pick a default
}

async function startRecording() {
  $("recState").textContent = "recording…";

  // Ask for a clean single-channel mic with basic DSP
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    },
  });

  state.chunks = [];
  const mimeType = pickAudioMime();
  state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  const startedAt = Date.now();

  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) state.chunks.push(e.data);
  };

  state.mediaRecorder.onstop = async () => {
    $("recState").textContent = "processing…";

    const blob = new Blob(state.chunks, { type: mimeType || "audio/webm" });
    const ms = Date.now() - startedAt;
    console.log("chunks recorded:", state.chunks.length);
    console.log("blob size:", blob.size);
    console.log("duration (ms):", ms);

    // Guard: require ~0.8s+ and a non-tiny blob (headers-only blobs are ~300–800 bytes)
    if (ms < 800 || blob.size < 12000) {
      $("transcript").textContent = "Hold the button and speak for ~1–2 seconds 👍";
      $("recState").textContent = "idle";
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      return;
    }

    const b64 = await blobToBase64(blob);
    console.log("base64 length:", (b64 || "").length);

    // Send to STT
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
      const reply = await chat(stt.text);
      $("reply").textContent = reply;
      state.lastReply = reply;
      feedAvatar(reply);

      const audioUrl = await tts(reply);
      if (audioUrl) {
        const player = $("ttsPlayer");
        player.src = audioUrl;
        player.play();
      }
    }

    $("recState").textContent = "idle";
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
  };

  // Start (single final chunk on stop)
  state.mediaRecorder.start();
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
}

function blobToBase64(blob) {
  return new Promise((res) => {
    const reader = new FileReader();
    reader.onloadend = () => res(reader.result);
    reader.readAsDataURL(blob);
  });
}

// ------------- API helpers -------------
async function chat(message) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!r.ok) {
    console.error("chat error", await r.text());
    return "";
  }
  const j = await r.json();
  return j.reply || "";
}

async function tts(text) {
  if (!text) return "";
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    console.error("TTS error", await r.text());
    return "";
  }
  const blob = await r.blob();
  return URL.createObjectURL(blob);
}

// ------------- Daily room (camera / screen share) -------------
$("createRoom").onclick = async () => {
  const r = await fetch("/api/rtc/create-room", { method: "POST" });
  if (!r.ok) { console.error("create room error", await r.text()); return; }
  const j = await r.json();
  state.dailyRoom = j.room;
  state.dailyUrl = j.url;
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
  iframe.style.width = "100%";
  iframe.style.height = "540px";
  iframe.style.border = "0";
  iframe.style.borderRadius = "12px";
  mount.appendChild(iframe);
};

$("closeRoom").onclick = () => {
  $("dailyMount").innerHTML = "";
  iframe = null;
};

// ------------- Avatar feed hook (for future video agent) -------------
function feedAvatar(text) {
  $("avatarFeed").textContent = (text || "").slice(0, 1200);
}
