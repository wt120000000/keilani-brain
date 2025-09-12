// public/assets/chat.js
const $ = (id) => document.getElementById(id);
const state = {
  mediaRecorder: null,
  chunks: [],
  dailyRoom: null,
  dailyUrl: null,
  meetingToken: null,
  lastReply: "",
};

// TEXT CHAT
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

// PUSH-TO-TALK
const pttBtn = $("pttBtn");
pttBtn.onmousedown = startRecording;
pttBtn.onmouseup = stopRecording;
pttBtn.ontouchstart = (e) => { e.preventDefault(); startRecording(); };
pttBtn.ontouchend = (e) => { e.preventDefault(); stopRecording(); };

async function startRecording() {
  $("recState").textContent = "recording…";
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.chunks = [];
  state.mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  state.mediaRecorder.ondataavailable = (e) => state.chunks.push(e.data);
  state.mediaRecorder.onstop = async () => {
    $("recState").textContent = "processing…";
    console.log("chunks recorded:", state.chunks.length);
    const blob = new Blob(state.chunks, { type: "audio/webm" });
    console.log("blob size:", blob.size);
    const b64 = await blobToBase64(blob);
    console.log("base64 length:", (b64 || "").length);

    const stt = await fetch("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: b64 })
    }).then(r => r.json()).catch(() => ({}));

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
  };
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

async function chat(message) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
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
    body: JSON.stringify({ text })
  });
  if (!r.ok) {
    console.error("TTS error", await r.text());
    return "";
  }
  const blob = await r.blob();
  return URL.createObjectURL(blob);
}

// DAILY ROOM (optional UI)
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
    body: JSON.stringify({ room: state.dailyRoom, userName: "Guest" })
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

// AVATAR HOOK
function feedAvatar(text) {
  $("avatarFeed").textContent = (text || "").slice(0, 1200);
}
