// public/keilaniStream.js
// v23 — sends userId with chat requests

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);

const startBtn     = $("start");
const stopBtn      = $("stop");
const pttBtn       = $("ptt");
const sendBtn      = $("send");

const msgEl        = $("message");
const replyEl      = $("reply");
const transcriptEl = $("transcript");
const lastAudioEl  = $("lastAudio");

const modeSel      = $("mode");          // "stream" | "plain"
const ttsSel       = $("ttsEngine");     // "ElevenLabs" | "browser"
const voiceIdEl    = $("voiceId");       // optional

const vadEl        = $("vad");           // 0..100 slider
const silenceEl    = $("silence");       // ms
const hudState     = $("state");
const hudStatus    = $("status");
const hudLat       = $("lat");

/* ---------- State ---------- */
const SM = { IDLE:"idle", LISTEN:"listening", REC:"recording", PROCESS:"processing", REPLY:"replying", SPEAK:"speaking" };
let sm = SM.IDLE;

let mediaStream = null;
let mediaRecorder = null;

let audioCtx = null;
let micSource = null;
let micAnalyser = null;

let outAnalyser = null;
let outSource = null;
let currentAudio = null;
let outIsPlaying = false;

let listenLoopOn = false;
let processingTurn = false;

let selectedVoice = null;
let speakStartedAt = 0;

let streamCtl = null;
let streamOn  = false;

let auto = false;

/* ---------- Tunables ---------- */
const REQUIRED_ONSET_FRAMES = 3;
const OUTPUT_MARGIN         = 0.008;
const TTS_GRACE_MS          = 200;

/* ---------- Helpers ---------- */
const setState   = (s) => { sm = s; hudState && (hudState.textContent = "state: " + s); };
const setStatus  = (s) => { if (hudStatus) hudStatus.firstChild.nodeValue = s + " "; };
const setLatency = (first, total) => { if (hudLat) hudLat.textContent = `${first!=null?`• first ${first} ms `:""}${total!=null?`• total ${total} ms`:""}`; };

function ema(prev, next, alpha){ return prev == null ? next : alpha*next + (1-alpha)*prev; }

function rmsFromAnalyser(an){
  if (!an) return 0;
  const buf = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i=0;i<buf.length;i++){ const v=(buf[i]-128)/128; sum += v*v; }
  return Math.sqrt(sum / buf.length);
}

function blobToDataUrl(blob){
  return new Promise(res => { const fr = new FileReader(); fr.onloadend = ()=>res(fr.result); fr.readAsDataURL(blob); });
}

function uuidv4(){
  // RFC4122-ish, good enough for client identity
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
}
function getUserId(){
  let id = localStorage.getItem("keilani_user_id");
  if (!id){ id = uuidv4(); localStorage.setItem("keilani_user_id", id); }
  return id;
}

/* ---------- Audio I/O ---------- */
async function ensureMic(){
  if (mediaStream) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
  });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  micSource = audioCtx.createMediaStreamSource(mediaStream);
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 2048;
  micSource.connect(micAnalyser);
}

function wireOutputAnalyser(audioEl){
  if (!audioCtx) return;
  try {
    outSource = audioCtx.createMediaElementSource(audioEl);
    outAnalyser = audioCtx.createAnalyser();
    outAnalyser.fftSize = 2048;
    outSource.connect(outAnalyser);
    outSource.connect(audioCtx.destination);
  } catch { /* Safari reuse guard */ }
}

function stopAudio(){
  if (currentAudio){
    try { currentAudio.pause(); } catch {}
    currentAudio.src = "";
  }
  currentAudio = null;
  outIsPlaying = false;
}

/* ---------- TTS ---------- */
async function speak(text){
  if (!text) { setState(SM.IDLE); return; }

  setState(SM.SPEAK);
  speakStartedAt = performance.now();

  if (ttsSel && ttsSel.value === "browser"){
    if (!("speechSynthesis" in window)) { setState(SM.IDLE); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (selectedVoice) u.voice = selectedVoice;
    u.onstart = () => { outIsPlaying = true; };
    u.onend   = () => { outIsPlaying = false; setState(SM.IDLE); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return;
  }

  try {
    const r = await fetch("/.netlify/functions/tts", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ text, voiceId: (voiceIdEl?.value || "").trim() || undefined })
    });
    const data = await r.json().catch(()=> ({}));
    if (!r.ok || !data?.audio) {
      console.warn("TTS error:", data);
      setState(SM.IDLE);
      return;
    }
    if (typeof data.audio === "string" && data.audio.startsWith("data:audio")){
      currentAudio = new Audio(data.audio);
      wireOutputAnalyser(currentAudio);
      currentAudio.addEventListener("playing", ()=>{ outIsPlaying=true; });
      currentAudio.addEventListener("pause",   ()=>{ outIsPlaying=false; });
      currentAudio.addEventListener("ended",   ()=>{ outIsPlaying=false; setState(SM.IDLE); });
      try { await currentAudio.play(); } catch { outIsPlaying=false; setState(SM.IDLE); }
      if (lastAudioEl) lastAudioEl.src = data.audio;
    } else {
      setState(SM.IDLE);
    }
  } catch (e) {
    console.warn("TTS exception:", e);
    setState(SM.IDLE);
  }
}

/* ---------- STT turn ---------- */
function startRecordingTurn(){
  if (!mediaStream) return;

  abortStream();
  stopAudio();

  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
             : MediaRecorder.isTypeSupported("audio/ogg")  ? "audio/ogg" : "";
  mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType:mime } : undefined);

  const chunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
    if (!blob || blob.size < 3000) {
      transcriptEl && (transcriptEl.textContent = "⚠️ Speak a bit longer.");
      processingTurn = false;
      setState(SM.LISTEN);
      return;
    }

    const dataUrl = await blobToDataUrl(blob);
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:audio") && lastAudioEl) {
      lastAudioEl.src = dataUrl;
    }

    try {
      const r = await fetch("/.netlify/functions/stt", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ audioBase64: dataUrl, language: "en" })
      });
      const j = await r.json();
      if (!r.ok) {
        transcriptEl && (transcriptEl.textContent = `⚠️ STT: ${j?.error || "error"}`);
        processingTurn = false;
        setState(SM.LISTEN);
        return;
      }
      transcriptEl && (transcriptEl.textContent = j.transcript || "");
      replyEl && (replyEl.textContent = "");
      processingTurn = false;

      const userId = getUserId();
      const payload = { message: j.transcript || "", userId, history: [] };

      if ((modeSel?.value || "").toLowerCase().startsWith("stream")) {
        chatStream(payload);
      } else {
        chatPlain(payload);
      }
    } catch (e) {
      transcriptEl && (transcriptEl.textContent = "⚠️ STT error: " + e.message);
      processingTurn = false;
      setState(SM.LISTEN);
    }
  };

  mediaRecorder.start(50);
  setState(SM.REC);
}

function stopRecordingTurn(){
  if (mediaRecorder && mediaRecorder.state !== "inactive"){
    processingTurn = true;
    mediaRecorder.stop();
    setState(SM.PROCESS);
  }
}

/* ---------- Streaming / Plain chat ---------- */
function abortStream(){ if (streamCtl){ try{streamCtl.abort();}catch{} streamCtl=null; } streamOn=false; stopBtn && (stopBtn.disabled=true); }

async function chatPlain(body){
  abortStream();
  stopAudio();
  setState(SM.REPLY); setStatus("thinking…"); setLatency(null,null);
  try{
    const r = await fetch("/api/chat", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok){ replyEl && (replyEl.textContent = `⚠️ ${j.error || "chat error"}`); setState(SM.IDLE); return; }
    replyEl && (replyEl.textContent = j.reply || "");
    speak(j.reply || "");
  }catch(e){
    replyEl && (replyEl.textContent = `⚠️ ${e.message}`);
    setState(SM.IDLE);
  }
}

async function chatStream(body){
  abortStream();
  stopAudio();
  setState(SM.REPLY); setStatus("streaming…"); setLatency(null,null);
  stopBtn && (stopBtn.disabled=false);

  const t0 = performance.now();
  let tFirst = null;
  let full = "";
  streamCtl = new AbortController();
  streamOn = true;

  try{
    const resp = await fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body),
      signal: streamCtl.signal
    });
    if (!resp.ok || !resp.body) throw new Error(`stream ${resp.status}`);

    const dec = new TextDecoder();
    const reader = resp.body.getReader();
    let buf = "";

    while(true){
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream:true });
      const lines = buf.split(/\r?\n/); buf = lines.pop() || "";
      for (const line of lines){
        const l = line.trim();
        if (!l || l.startsWith(":")) continue;
        if (l === "data: [DONE]" || l === "[DONE]"){ buf=""; break; }
        const payload = l.startsWith("data:") ? l.slice(5).trim() : l;

        if (tFirst == null){ tFirst = Math.round(performance.now() - t0); setLatency(tFirst, null); }

        try{
          const j = JSON.parse(payload);
          const tok = j?.choices?.[0]?.delta?.content ?? j?.content ?? "";
          if (tok){ full += tok; replyEl && (replyEl.textContent = full); }
        }catch{
          full += payload; replyEl && (replyEl.textContent = full);
        }
      }
    }
  }catch(e){
    if (e.name !== "AbortError"){ replyEl && (replyEl.textContent = `⚠️ ${e.message}`); }
  }finally{
    const tTot = Math.round(performance.now() - t0);
    setLatency(tFirst ?? null, tTot);
    streamOn=false; stopBtn && (stopBtn.disabled=true); setStatus("idle");
  }

  if (full) speak(full);
}

/* ---------- VAD loop ---------- */
function startListening(){
  if (!mediaStream) return;
  listenLoopOn = true;
  setState(SM.LISTEN);

  let onsetFrames = 0;
  let voiced = false;
  let lastSound = performance.now();
  let outEma = null;

  const tick = () => {
    if (!listenLoopOn) return;

    const thr     = (Number(vadEl?.value) || 35) / 3000;
    const silence = Math.max(200, Math.min(4000, Number(silenceEl?.value) || 700));

    const micRms = rmsFromAnalyser(micAnalyser);
    const outRms = rmsFromAnalyser(outAnalyser);
    outEma = ema(outEma, outRms, 0.2);

    const now = performance.now();
    const graceActive = (sm === SM.SPEAK) && (now - speakStartedAt < TTS_GRACE_MS);

    const micBeatsOutput = outIsPlaying ? (micRms > ((outEma || 0) + OUTPUT_MARGIN)) : true;

    if (!processingTurn && !graceActive){
      if (micRms > thr && micBeatsOutput){
        onsetFrames++;
        if (!voiced && onsetFrames >= REQUIRED_ONSET_FRAMES){
          stopAudio();
          abortStream();
          startRecordingTurn();
          voiced = true;
          lastSound = now;
          onsetFrames = 0;
        }
      } else {
        onsetFrames = 0;
      }
    }

    if (voiced) lastSound = now;

    if (voiced && (now - lastSound) > silence){
      voiced = false;
      stopRecordingTurn();
    }

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

function stopListening(){
  listenLoopOn = false;
  if (mediaRecorder && mediaRecorder.state !== "inactive"){
    try { mediaRecorder.stop(); } catch {}
  }
  setState(SM.IDLE);
}

/* ---------- UI wiring ---------- */
if (sendBtn) {
  sendBtn.addEventListener("click", () => {
    const t = (msgEl?.value || "").trim();
    if (!t) return;
    replyEl && (replyEl.textContent = "");
    transcriptEl && (transcriptEl.textContent = "–");
    const body = { message: t, userId: getUserId(), history: [] };
    if ((modeSel?.value || "").toLowerCase().startsWith("stream")) chatStream(body);
    else chatPlain(body);
    if (msgEl){ msgEl.value = ""; msgEl.focus(); }
  });
}

if (stopBtn) stopBtn.addEventListener("click", () => { abortStream(); stopAudio(); setLatency(null,null); setState(SM.IDLE); });

if (pttBtn){
  pttBtn.addEventListener("mousedown",  () => startRecordingTurn());
  pttBtn.addEventListener("touchstart", () => startRecordingTurn(), { passive:true });
  pttBtn.addEventListener("mouseup",    () => stopRecordingTurn());
  pttBtn.addEventListener("mouseleave", () => stopRecordingTurn());
  pttBtn.addEventListener("touchend",   () => stopRecordingTurn());
}

if (startBtn){
  startBtn.addEventListener("click", async () => {
    try { await ensureMic(); } catch {}
    startListening();
  });
}

/* Browser voices */
function loadVoices(){
  const arr = (window.speechSynthesis?.getVoices?.() || []).filter(v => v.lang?.startsWith?.("en"));
  selectedVoice = arr[0] || null;
}
if ("speechSynthesis" in window){ loadVoices(); window.speechSynthesis.onvoiceschanged = loadVoices; }

/* ---------- Boot ---------- */
(function boot(){
  console.log("[keilani] client boot v23");
  setStatus("idle");
})();
