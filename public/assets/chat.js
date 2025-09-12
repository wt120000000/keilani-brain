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
  voiceId: null, // selected ElevenLabs voice
};

// ---------------- Voice selector (dynamic) ----------------
(async function initVoices() {
  const sel = $("voiceSelect");
  if (!sel) return; // page might not include the selector yet

  sel.disabled = true;
  sel.innerHTML = `<option>Loading voices…</option>`;
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
    } else {
      state.voiceId = sel.value || null;
      sel.disabled = false;
      sel.onchange = () => (state.voiceId = sel.value || null);
    }
  } catch (e) {
    console.error("voices load failed:", e);
    sel.innerHTML = `<option value="">(voices unavailable)</option>`;
    sel.disabled = true;
  }
})();

// ---------------- Text chat ----------------
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
  const url = await tts(state.lastReply);
  if (url) {
    const p = $("ttsPlayer");
    p.src = url;
    p.play();
  }
};

// ---------------- Push-to-talk (reliable recorder) ----------------
const pttBtn = $("pttBtn");
pttBtn.onmousedown = startRecording;
pttBtn.onmouseup = stopRecording;
pttBtn.ontouchstart = (e) => {
  e.preventDefault();
  startRecording();
};
pttBtn.ontouchend = (e) => {
  e.preventDefault();
  stopRecording();
};

function pickAudioMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return ""; // let browser choose
}

async function startRecording() {
  $("recState").textContent = "recording…";

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

    // Guard tiny/short clips (headers-only blobs are a few hundred bytes)
    if (ms < 800 || blob.size < 12000) {
      $("transcript").textContent = "Hold the button and speak for ~1–2 seconds 👍";
      $("recState").textContent = "idle";
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      return;
    }

    const b64 = await blobToBase64(blob);
    console.log("base64 length:", (b64 || "").length);

    const sttResp = await fetch("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: b64 }),
    });

    if (!sttResp.ok) {
      console.error("STT error:", await sttResp.text());
      $("transcript").textContent = "Couldn’t transcribe. Try again.";
      $("recState").textContent = "idle";
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      return;
    }

    const stt = await sttResp.json();
    $("transcript").textContent = stt.text || "";

    if (stt.text) {
      const reply = await chat(stt.text);
      $("reply").textContent = reply;
      state.lastReply = reply;
      feedAvatar(reply);

      const url = await tts(reply);
      if (url) {
        const p = $("ttsPlayer");
        p.src = url;
        p.play();
      }
    }

    $("recState").textContent = "idle";
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
  };

  state.mediaRecorder.start(); // single final chunk on stop
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

// ---------------- API helpers ----------------
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
  const body = { text };
  if (state.voiceId) body.voiceId = state.voiceId;

  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error("TTS error", await r.text());
    return "";
  }
  const blob = await r.blob();
  return URL.createObjectURL(blob);
}

// ---------------- Daily room (camera / screen share) ----------------
$("createRoom").onclick = async () => {
  const r = await fetch("/api/rtc/create-room", { method: "POST" });
  if (!r.ok) {
    console.error("create room error", await r.text());
    return;
  }
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

// ---------------- Avatar feed hook ----------------
function feedAvatar(text) {
  $("avatarFeed").textContent = (text || "").slice(0, 1200);
}
