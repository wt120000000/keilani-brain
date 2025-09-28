// Chat (JSON or SSE stream) + TTS (Browser/ElevenLabs) + Push-to-talk + Auto talk (VAD) + timing

// --- DOM refs ---
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stopStream");
const pttBtn  = document.getElementById("ptt");
const autoBtn = document.getElementById("autoTalk");

const streamToggle = document.getElementById("streamToggle");
const msgEl = document.getElementById("message");
const userEl = document.getElementById("userId");
const statusEl = document.getElementById("status");
const latencyEl = document.getElementById("latency");
const replyEl = document.getElementById("reply");
const matchesEmpty = document.getElementById("matchesEmpty");
const matchesTable = document.getElementById("matchesTable");
const matchesBody = document.getElementById("matchesBody");
const thresholdEl = document.getElementById("threshold");
const countEl = document.getElementById("count");
const skipContextEl = document.getElementById("skipContext");

const stateText = document.getElementById("stateText");
const convState = document.getElementById("convState");

const ttsEngineEl = document.getElementById("ttsEngine");
const voiceLocalSel = document.getElementById("voiceLocal");
const voiceLocalWrap = document.getElementById("voiceLocalWrap");
const voiceIdWrap = document.getElementById("voiceIdWrap");
const voiceIdEl = document.getElementById("voiceId");
const rateEl = document.getElementById("rate");
const pitchEl = document.getElementById("pitch");
const toggleTTSBtn = document.getElementById("toggleTTS");
const speakReplyBtn = document.getElementById("speakReply");

const vadEl = document.getElementById("vad");
const silenceMsEl = document.getElementById("silenceMs");

const lastTranscriptEl = document.getElementById("lastTranscript");
const lastAudio = document.getElementById("lastAudio");

// Health bits
const healthRefresh = document.getElementById("healthRefresh");
const healthDot = document.getElementById("healthDot");
const healthText = document.getElementById("healthText");
const healthBadge = document.getElementById("healthBadge");

// --- Global state ---
let ttsEnabled = true;
let currentAudio = null;             // barge-in handle
let currentStreamController = null;  // AbortController for SSE
let streamActive = false;

let voices = [];
let selectedVoice = null;

// Mic / Auto talk
let mediaStream = null;
let mediaRecorder = null;
let audioCtx = null;
let analyser = null;
let vadTimer = 0;
let speaking = false;
let autoMode = false;
let listenLoopActive = false;

// Utils
function setStatus(s) { statusEl.firstChild.nodeValue = s + " "; }
function setLatency(firstMs, totalMs) {
  latencyEl.textContent = (firstMs != null ? `• first ${firstMs} ms` : "") + (totalMs != null ? ` • total ${totalMs} ms` : "");
}
function setState(s) { stateText.textContent = s; }
function setConv(s) { convState.textContent = s ? `• ${s}` : ""; }

// ---------- Health ----------
async function refreshHealth() {
  try {
    healthText.textContent = "checking…";
    healthDot.className = "dot";
    const resp = await fetch("/api/health", { cache: "no-store" });
    const ok = await resp.json();
    const allTrue = ok.has_OPENAI_API_KEY && ok.has_OPENAI_MODEL && ok.has_EMBED_MODEL && ok.has_SUPABASE_URL && ok.has_SUPABASE_SERVICE_ROLE;
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
refreshHealth(); setInterval(refreshHealth, 30000);

// ---------- TTS ----------
function populateVoices() {
  voices = (window.speechSynthesis?.getVoices?.() || []).filter(v => v.lang?.startsWith?.("en"));
  voiceLocalSel.innerHTML = voices.length ? voices.map((v,i)=>`<option value="${i}">${v.name} (${v.lang})${v.default?" — default":""}</option>`).join("") : `<option>(No voices)</option>`;
  selectedVoice = voices[0] || null;
}
if ("speechSynthesis" in window) {
  populateVoices();
  window.speechSynthesis.onvoiceschanged = populateVoices;
}
voiceLocalSel.addEventListener("change", e => { selectedVoice = voices[Number(e.target.value)] || null; });

toggleTTSBtn.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  toggleTTSBtn.textContent = ttsEnabled ? "🔊 TTS: On" : "🔇 TTS: Off";
  toggleTTSBtn.classList.toggle("secondary", true);
});
speakReplyBtn.addEventListener("click", () => {
  const text = replyEl.textContent.trim();
  if (text && text !== "–") ttsSpeak(text);
});

function applyTtsEngineUI() {
  const engine = ttsEngineEl.value;
  if (engine === "elevenlabs") { voiceLocalWrap.style.display="none"; voiceIdWrap.style.display=""; }
  else { voiceLocalWrap.style.display=""; voiceIdWrap.style.display="none"; }
}
(function bootEngineFromStorage(){
  const saved = localStorage.getItem("ttsEngine"); if (saved) ttsEngineEl.value = saved;
  const savedVoiceId = localStorage.getItem("elevenVoiceId"); if (savedVoiceId) voiceIdEl.value = savedVoiceId;
  applyTtsEngineUI();
})();
ttsEngineEl.addEventListener("change", ()=>{ localStorage.setItem("ttsEngine", ttsEngineEl.value); applyTtsEngineUI(); });
voiceIdEl.addEventListener("change", ()=>{ localStorage.setItem("elevenVoiceId", voiceIdEl.value.trim()); });

function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio.src = ""; currentAudio = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}
function onTtsEnded(cb){
  if (currentAudio) currentAudio.onended = cb;
  else if (window.speechSynthesis) {
    // crude: wait ~duration based on char length if needed, but here we use events
    // Web Speech has onend on the utterance, so we set it in ttsSpeak.
  }
}
async function ttsSpeak(text) {
  if (!ttsEnabled || !text) return;
  stopAudio(); // barge-in

  if (ttsEngineEl.value === "browser") {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    if (selectedVoice) u.voice = selectedVoice;
    u.rate = Math.min(2, Math.max(0.5, Number(rateEl.value) || 1.0));
    u.pitch = Math.min(2, Math.max(0, Number(pitchEl.value) || 1.0));
    u.onend = () => { if (autoMode) startAutoListen(); };
    window.speechSynthesis.speak(u);
    return;
  }
  try {
    const body = { text, voiceId: (voiceIdEl.value || "").trim() || undefined };
    const r = await fetch("/.netlify/functions/tts", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok || !data?.audio) { console.warn("TTS error:", data); if (autoMode) startAutoListen(); return; }
    if (typeof data.audio === "string" && data.audio.startsWith("data:audio")) {
      currentAudio = new Audio(data.audio);
      currentAudio.onended = () => { if (autoMode) startAutoListen(); };
      currentAudio.play().catch(()=>{ if (autoMode) startAutoListen(); });
      lastAudio.src = data.audio;
    } else if (autoMode) startAutoListen();
  } catch (e) {
    console.warn("TTS exception:", e);
    if (autoMode) startAutoListen();
  }
}

// ---------- Chat ----------
function renderMatches(matches) {
  const arr = Array.isArray(matches) ? matches : [];
  if (!arr.length) { matchesEmpty.style.display="block"; matchesTable.style.display="none"; return; }
  matchesEmpty.style.display="none"; matchesTable.style.display="";
  matchesBody.innerHTML = arr.map(m => `<tr><td>${escapeHtml(m.title||"")}</td><td>${escapeHtml(m.source||"")}</td><td>${Number(m.similarity||0).toFixed(3)}</td></tr>`).join("");
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

async function chatJSON(message) {
  const qs = new URLSearchParams();
  const threshold = Number(thresholdEl.value || 0.6);
  const count = Number(countEl.value || 8);
  const skip = !!skipContextEl.checked;
  if (skip) qs.set("nocontext","1"); else { qs.set("threshold", String(threshold)); qs.set("count", String(count)); }

  setStatus("thinking…"); setLatency(null,null); sendBtn.disabled = true;
  try {
    const resp = await fetch(`/api/chat?${qs}`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userId: userEl.value || "00000000-0000-0000-0000-000000000001", message })
    });
    const data = await resp.json();
    if (!resp.ok) { replyEl.textContent = `⚠️ ${data.error || "Chat error"}`; matchesEmpty.style.display="block"; matchesTable.style.display="none"; return; }
    replyEl.textContent = data.reply || "—";
    renderMatches(data.matches);
    ttsSpeak(data.reply || "");
  } catch (e) {
    replyEl.textContent = `⚠️ Network error: ${e.message}`;
    matchesEmpty.style.display="block"; matchesTable.style.display="none";
    if (autoMode) startAutoListen();
  } finally { setStatus("idle"); sendBtn.disabled = false; }
}

async function chatStream(message) {
  stopAudio(); abortStream();
  setStatus("streaming…"); setLatency(null,null); sendBtn.disabled = true; stopBtn.disabled = false;
  convState.textContent = "• replying";

  const t0 = performance.now();
  let tFirst = null, assistant = "";
  currentStreamController = new AbortController(); streamActive = true;

  try {
    const resp = await fetch(`/api/chat-stream`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ message, history: [] }),
      signal: currentStreamController.signal
    });
    if (!resp.ok || !resp.body) throw new Error(`Bad stream: ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n/); buffer = parts.pop() || "";

      for (const line of parts) {
        const l = line.trim(); if (!l || l.startsWith(":")) continue;
        if (l === "data: [DONE]" || l === "[DONE]") { buffer=""; break; }
        let data = l.startsWith("data:") ? l.slice(5).trim() : l;

        if (tFirst == null) { tFirst = Math.round(performance.now()-t0); setLatency(tFirst,null); console.log("[stream] first token", tFirst, "ms"); }

        try {
          const obj = JSON.parse(data);
          const token = obj?.choices?.[0]?.delta?.content ?? obj?.content ?? "";
          if (token) { assistant += token; replyEl.textContent = assistant; }
        } catch { assistant += data; replyEl.textContent = assistant; }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") replyEl.textContent = `⚠️ Stream error: ${e.message}`;
  } finally {
    const tTotal = Math.round(performance.now()-t0);
    setLatency(tFirst ?? null, tTotal);
    console.log("[stream] total", tTotal, "ms");
    streamActive = false; stopBtn.disabled = true; sendBtn.disabled = false; convState.textContent = "";
  }
  if (assistant) ttsSpeak(assistant);
}

sendBtn.addEventListener("click", () => {
  const msg = msgEl.value.trim(); if (!msg) return;
  replyEl.textContent = ""; (streamToggle.checked ? chatStream : chatJSON)(msg);
  msgEl.value = ""; msgEl.focus();
});
stopBtn.addEventListener("click", () => { abortStream(); stopAudio(); setStatus("idle"); setLatency(null,null); });
msgEl.addEventListener("keydown", e => { if (e.key==="Enter" && (e.ctrlKey || e.metaKey)) sendBtn.click(); });

function abortStream(){ if (currentStreamController){ currentStreamController.abort(); currentStreamController=null; } streamActive=false; stopBtn.disabled=true; }

// ---------- Hold-to-talk (manual) ----------
pttBtn.addEventListener("mousedown", manualStart);
pttBtn.addEventListener("touchstart", manualStart, { passive:true });
pttBtn.addEventListener("mouseup", manualStop);
pttBtn.addEventListener("mouseleave", manualStop);
pttBtn.addEventListener("touchend", manualStop);

async function manualStart(){ await ensureMic(); startRecorder(); pttBtn.textContent="🛑 Release to send"; stopAudio(); abortStream(); }
function manualStop(){ if (mediaRecorder && mediaRecorder.state!=="inactive"){ mediaRecorder.stop(); pttBtn.textContent="🎙 Hold to talk"; } }

// ---------- Auto talk (hands-free) ----------
autoBtn.addEventListener("click", async () => {
  autoMode = !autoMode;
  autoBtn.textContent = autoMode ? "🔁 Auto talk: On" : "🔁 Auto talk: Off";
  autoBtn.classList.toggle("secondary", true);
  if (autoMode) { await ensureMic(); startAutoListen(); } else { stopAuto(); }
});

function stopAuto(){
  listenLoopActive = false;
  setState("idle"); setConv("");
  if (mediaRecorder && mediaRecorder.state!=="inactive") mediaRecorder.stop();
}

async function ensureMic(){
  if (mediaStream) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
}

function getRms() {
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i=0;i<buf.length;i++){
    const v = (buf[i]-128)/128; sum += v*v;
  }
  return Math.sqrt(sum/buf.length);
}

function startAutoListen(){
  if (!mediaStream) return;
  if (listenLoopActive) return;
  listenLoopActive = true;
  stopAudio(); abortStream();
  setState("listening"); setConv("you");

  const threshold = (Number(vadEl.value)||35) / 3000; // rough map: 0.003–0.033
  const silenceMs = Math.max(200, Math.min(3000, Number(silenceMsEl.value)||700));
  let voiced = false;
  let silentSince = performance.now();

  const tick = () => {
    if (!listenLoopActive) return;
    const rms = getRms();
    const now = performance.now();

    if (rms > threshold) {
      // user is speaking
      if (!voiced) { voiced = true; startRecorder(); setState("recording"); stopAudio(); abortStream(); }
      silentSince = now;
    } else if (voiced && (now - silentSince) > silenceMs) {
      // speech ended
      voiced = false; if (mediaRecorder && mediaRecorder.state!=="inactive") mediaRecorder.stop();
      setState("processing");
      return; // wait for onstop to restart listening
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function startRecorder(){
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
            : MediaRecorder.isTypeSupported("audio/ogg") ? "audio/ogg" : "";
  mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size>0) chunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
    if (!blob || blob.size < 5000) { lastTranscriptEl.textContent = "⚠️ Try speaking a bit longer (clip too short)."; if (autoMode) startAutoListen(); return; }
    const dataUrl = await blobToDataUrl(blob);
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:audio")) lastAudio.src = dataUrl;

    try {
      const r = await fetch("/.netlify/functions/stt", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ audioBase64: dataUrl, language: "en" })
      });
      const stt = await r.json();
      if (!r.ok) { lastTranscriptEl.textContent = `⚠️ STT: ${stt?.error || "error"}`; if (autoMode) startAutoListen(); return; }
      const transcript = stt?.transcript || "";
      lastTranscriptEl.textContent = transcript || "–";
      replyEl.textContent = "";
      setConv("keilani");
      if (streamToggle.checked) await chatStream(transcript); else await chatJSON(transcript);
      // ttsSpeak() will call startAutoListen() when audio ends (or immediately if TTS off)
      if (!ttsEnabled) { if (autoMode) startAutoListen(); }
    } catch (e) {
      lastTranscriptEl.textContent = "⚠️ STT error: " + e.message;
      if (autoMode) startAutoListen();
    }
  };
  mediaRecorder.start(50);
}

function blobToDataUrl(blob) {
  return new Promise(res => { const fr = new FileReader(); fr.onloadend = () => res(fr.result); fr.readAsDataURL(blob); });
}
