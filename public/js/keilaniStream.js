// Chat + TTS (Browser/ElevenLabs) + Push-to-talk -> STT -> Chat -> TTS
const sendBtn = document.getElementById("send");
const msgEl = document.getElementById("message");
const userEl = document.getElementById("userId");
const statusEl = document.getElementById("status");
const replyEl = document.getElementById("reply");
const matchesEmpty = document.getElementById("matchesEmpty");
const matchesTable = document.getElementById("matchesTable");
const matchesBody = document.getElementById("matchesBody");
const thresholdEl = document.getElementById("threshold");
const countEl = document.getElementById("count");
const skipContextEl = document.getElementById("skipContext");

const healthBadge = document.getElementById("healthBadge");
const healthDot = document.getElementById("healthDot");
const healthText = document.getElementById("healthText");
const healthRefresh = document.getElementById("healthRefresh");

// TTS controls
const ttsEngineEl = document.getElementById("ttsEngine");
const voiceLocalSel = document.getElementById("voiceLocal");
const rateEl = document.getElementById("rate");
const pitchEl = document.getElementById("pitch");
const toggleTTSBtn = document.getElementById("toggleTTS");
const speakReplyBtn = document.getElementById("speakReply");

const voiceIdWrap = document.getElementById("voiceIdWrap");
const voiceLocalWrap = document.getElementById("voiceLocalWrap");
const voiceIdEl = document.getElementById("voiceId");

const pttBtn = document.getElementById("ptt");
const lastTranscriptEl = document.getElementById("lastTranscript");
const lastAudio = document.getElementById("lastAudio");

// ---------- State ----------
let ttsEnabled = true;
let voices = [];
let selectedVoice = null;
let currentAudio = null; // barge-in handle
let mediaRecorder = null;
let mediaStream = null;

function setStatus(s) { statusEl.textContent = s; }

// ---------- HEALTH ----------
async function refreshHealth() {
  try {
    healthText.textContent = "checking…";
    healthDot.className = "dot";
    const resp = await fetch("/api/health", { cache: "no-store" });
    const ok = await resp.json();
    const allTrue =
      ok.has_OPENAI_API_KEY &&
      ok.has_OPENAI_MODEL &&
      ok.has_EMBED_MODEL &&
      ok.has_SUPABASE_URL &&
      ok.has_SUPABASE_SERVICE_ROLE;
    healthDot.className = "dot " + (allTrue ? "ok" : "warn");
    healthText.textContent = allTrue ? "OK" : "Degraded";
    healthBadge.title = JSON.stringify(ok, null, 2);
  } catch (e) {
    healthDot.className = "dot err";
    healthText.textContent = "Error";
    healthBadge.title = e.message;
  }
}
healthRefresh.addEventListener("click", refreshHealth);
refreshHealth();
setInterval(refreshHealth, 30000);

// ---------- TTS: engine switching ----------
function applyTtsEngineUI() {
  const engine = ttsEngineEl.value;
  if (engine === "elevenlabs") {
    voiceLocalWrap.style.display = "none";
    voiceIdWrap.style.display = "";
  } else {
    voiceLocalWrap.style.display = "";
    voiceIdWrap.style.display = "none";
  }
}
ttsEngineEl.addEventListener("change", () => {
  localStorage.setItem("ttsEngine", ttsEngineEl.value);
  applyTtsEngineUI();
});

(function bootEngineFromStorage() {
  const saved = localStorage.getItem("ttsEngine");
  if (saved) ttsEngineEl.value = saved;
  const savedVoiceId = localStorage.getItem("elevenVoiceId");
  if (savedVoiceId) voiceIdEl.value = savedVoiceId;
  applyTtsEngineUI();
})();

voiceIdEl.addEventListener("change", () => {
  localStorage.setItem("elevenVoiceId", voiceIdEl.value.trim());
});

// ---------- TTS: Browser voices ----------
function populateVoices() {
  voices = (window.speechSynthesis?.getVoices?.() || []).filter((v) => v.lang?.startsWith?.("en"));
  voiceLocalSel.innerHTML =
    voices.map((v, i) => `<option value="${i}">${v.name} (${v.lang})${v.default ? " — default" : ""}</option>`).join("")
    || `<option value="">(No voices found)</option>`;
  selectedVoice = voices[0] || null;
}
if ("speechSynthesis" in window) {
  populateVoices();
  window.speechSynthesis.onvoiceschanged = populateVoices;
}
voiceLocalSel.addEventListener("change", (e) => {
  const idx = Number(e.target.value);
  selectedVoice = voices[idx] || null;
});

toggleTTSBtn.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  toggleTTSBtn.textContent = ttsEnabled ? "🔊 TTS: On" : "🔇 TTS: Off";
  toggleTTSBtn.classList.toggle("secondary", true);
});

speakReplyBtn.addEventListener("click", () => {
  const text = replyEl.textContent.trim();
  if (text && text !== "–") ttsSpeak(text);
});

// ---------- TTS core (barge-in) ----------
function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

async function ttsSpeak(text) {
  if (!ttsEnabled || !text) return;
  stopAudio(); // barge-in

  const engine = ttsEngineEl.value;
  if (engine === "browser") {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    if (selectedVoice) u.voice = selectedVoice;
    u.rate = Math.min(2, Math.max(0.5, Number(rateEl.value) || 1.0));
    u.pitch = Math.min(2, Math.max(0, Number(pitchEl.value) || 1.0));
    window.speechSynthesis.speak(u);
    return;
  }

  // ElevenLabs via proxy
  try {
    const body = {
      text,
      voiceId: (voiceIdEl.value || "").trim() || undefined
    };
    const r = await fetch("/.netlify/functions/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok || !data?.audio) {
      console.warn("TTS error:", data);
      return;
    }
    currentAudio = new Audio(data.audio);
    currentAudio.play().catch(() => {});
    lastAudio.src = data.audio; // keep a copy under the player
  } catch (e) {
    console.warn("TTS exception:", e);
  }
}

// ---------- Chat (JSON) ----------
async function sendToKeilani(message) {
  const threshold = Number(thresholdEl.value || 0.6);
  const count = Number(countEl.value || 8);
  const skip = skipContextEl.checked;

  const qs = new URLSearchParams();
  if (skip) qs.set("nocontext", "1");
  else { qs.set("threshold", String(threshold)); qs.set("count", String(count)); }

  const url = `/api/chat?${qs.toString()}`;
  const body = { userId: userEl.value || "00000000-0000-0000-0000-000000000001", message };

  setStatus("thinking…");
  sendBtn.disabled = true;

  try {
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await resp.json();

    if (!resp.ok) {
      replyEl.textContent = `⚠️ ${data.error || "Chat error"}`;
      matchesEmpty.style.display = "block";
      matchesTable.style.display = "none";
      return;
    }

    replyEl.textContent = data.reply || "—";
    ttsSpeak(data.reply || "");

    const matches = Array.isArray(data.matches) ? data.matches : [];
    if (matches.length === 0) {
      matchesEmpty.style.display = "block";
      matchesTable.style.display = "none";
    } else {
      matchesEmpty.style.display = "none";
      matchesTable.style.display = "";
      matchesBody.innerHTML = matches
        .map((m) => `<tr><td>${escapeHtml(m.title || "")}</td><td>${escapeHtml(m.source || "")}</td><td>${Number(m.similarity || 0).toFixed(3)}</td></tr>`)
        .join("");
    }
  } catch (e) {
    replyEl.textContent = `⚠️ Network error: ${e.message}`;
    matchesEmpty.style.display = "block";
    matchesTable.style.display = "none";
  } finally {
    setStatus("idle");
    sendBtn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

sendBtn.addEventListener("click", () => {
  const msg = msgEl.value.trim();
  if (!msg) return;
  sendToKeilani(msg);
  msgEl.value = "";
  msgEl.focus();
});

msgEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    sendBtn.click();
  }
});

// ---------- Push-to-talk (MediaRecorder -> STT -> Chat) ----------
async function ensureMic() {
  if (mediaStream) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
}

function blobToDataUrl(blob) {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onloadend = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
}

pttBtn.addEventListener("mousedown", startPTT);
pttBtn.addEventListener("touchstart", startPTT, { passive: true });
pttBtn.addEventListener("mouseup", stopPTT);
pttBtn.addEventListener("mouseleave", stopPTT);
pttBtn.addEventListener("touchend", stopPTT);

async function startPTT() {
  try {
    await ensureMic();
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" :
                 MediaRecorder.isTypeSupported("audio/ogg") ? "audio/ogg" : "";
    mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
        const dataUrl = await blobToDataUrl(blob);
        lastAudio.src = dataUrl; // preview mic capture

        // Send to STT
        const r = await fetch("/.netlify/functions/stt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64: dataUrl, language: "en" })
        });
        const stt = await r.json();
        const transcript = stt?.transcript || "";
        lastTranscriptEl.textContent = transcript || "–";
        if (transcript) {
          msgEl.value = transcript;
          await sendToKeilani(transcript);
        }
      } catch (e) {
        lastTranscriptEl.textContent = "⚠️ STT error: " + e.message;
      }
    };
    mediaRecorder.start();
    pttBtn.textContent = "🛑 Release to send";
    pttBtn.disabled = false;
  } catch (e) {
    alert("Microphone error: " + e.message);
  }
}
function stopPTT() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    pttBtn.textContent = "🎙 Hold to talk";
  }
}
