/* keilaniStream.js
 * Live chat + voice loop with output-aware VAD and barge-in.
 * Works with:
 *  - /.netlify/functions/stt  (POST {audioBase64})
 *  - /.netlify/functions/tts  (POST {text, voiceId?})
 *  - /api/chat                 (plain JSON reply)
 *  - /api/chat-stream          (SSE streaming)
 *
 * UI elements by id (already in index.html):
 *  send, stop, ptt, auto, message, reply, transcript, lastAudio,
 *  mode, ttsEngine, voiceId, vad, silence, state, status, lat
 */

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);

const sendBtn      = $("send");
const stopBtn      = $("stop");
const pttBtn       = $("ptt");
const autoBtn      = $("auto");

const msgEl        = $("message");
const replyEl      = $("reply");
const transcriptEl = $("transcript");
const lastAudioEl  = $("lastAudio");

const modeSel      = $("mode");          // "stream" | "plain"
const ttsSel       = $("ttsEngine");     // "ElevenLabs" | "browser"
const voiceIdEl    = $("voiceId");       // optional

const vadEl        = $("vad");           // 0..100 slider (we map to threshold)
const silenceEl    = $("silence");       // ms
const stateEl      = $("state");
const statusEl     = $("status");
const latEl        = $("lat");

/* ---------- State ---------- */
const SM = { IDLE:"idle", LISTEN:"listening", REC:"recording", PROCESS:"processing", REPLY:"replying", SPEAK:"speaking" };
let sm = SM.IDLE;
let auto = false;

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

/* ---------- Tunables (more permissive than before) ---------- */
const REQUIRED_ONSET_FRAMES = 3;     // how many animation frames mic must be hot to "start talking"
const OUTPUT_MARGIN         = 0.008; // mic must exceed output by this RMS when audio is playing
const TTS_GRACE_MS          = 200;   // ignore mic for a short grace after TTS begins

/* ---------- Helpers ---------- */
const setState   = (s) => { sm = s; stateEl.textContent  = "state: " + s; };
const setStatus  = (s) => { statusEl.firstChild.nodeValue = s + " "; };
const setLatency = (first, total) => { latEl.textContent = `${first!=null?`• first ${first} ms `:""}${total!=null?`• total ${total} ms`:""}`; };

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
    outSource.connect(audioCtx.destination); // so we hear it
  } catch {
    // Safari throws if you reuse a MediaElementSource; safe to ignore
  }
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
  if (!text) { if (auto) startListening(); else setState(SM.IDLE); return; }

  setState(SM.SPEAK);
  speakStartedAt = performance.now();

  // Browser TTS fallback
  if (ttsSel.value === "browser"){
    if (!("speechSynthesis" in window)) { if (auto) startListening(); else setState(SM.IDLE); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (selectedVoice) u.voice = selectedVoice;
    u.onstart = () => { outIsPlaying = true; };
    u.onend   = () => { outIsPlaying = false; if (auto) startListening(); else setState(SM.IDLE); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return;
  }

  // ElevenLabs (server function)
  try {
    const r = await fetch("/.netlify/functions/tts", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ text, voiceId: (voiceIdEl.value || "").trim() || undefined })
    });
    const data = await r.json().catch(()=> ({}));
    if (!r.ok || !data?.audio) {
      console.warn("TTS error:", data);
      // Don’t stall the loop if TTS fails
      if (auto) startListening(); else setState(SM.IDLE);
      return;
    }
    if (typeof data.audio === "string" && data.audio.startsWith("data:audio")){
      currentAudio = new Audio(data.audio);
      wireOutputAnalyser(currentAudio);
      currentAudio.addEventListener("playing", ()=>{ outIsPlaying=true; });
      currentAudio.addEventListener("pause",   ()=>{ outIsPlaying=false; });
      currentAudio.addEventListener("ended",   ()=>{ outIsPlaying=false; if (auto) startListening(); else setState(SM.IDLE); });
      try { await currentAudio.play(); } catch { outIsPlaying=false; if (auto) startListening(); else setState(SM.IDLE); }
      lastAudioEl.src = data.audio;
    } else {
      if (auto) startListening(); else setState(SM.IDLE);
    }
  } catch (e) {
    console.warn("TTS exception:", e);
    if (auto) startListening(); else setState(SM.IDLE);
  }
}

/* ---------- STT turn ---------- */
function startRecordingTurn(){
  if (!mediaStream) return;

  // barge-in: stop anything ongoing
  abortStream();
  stopAudio();

  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
             : MediaRecorder.isTypeSupported("audio/ogg")  ? "audio/ogg" : "";
  mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType:mime } : undefined);

  const chunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
    if (!blob || blob.size < 5000) {
      transcriptEl.textContent = "⚠️ Speak a bit longer.";
      processingTurn = false;
      if (auto) setState(SM.LISTEN);
      return;
    }

    const dataUrl = await blobToDataUrl(blob);
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:audio")) {
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
        transcriptEl.textContent = `⚠️ STT: ${j?.error || "error"}`;
        processingTurn = false;
        if (auto) setState(SM.LISTEN);
        return;
      }
      transcriptEl.textContent = j.transcript || "";
      replyEl.textContent = "";
      processingTurn = false;

      if ((modeSel.value || "").toLowerCase().startsWith("stream")) {
        chatStream(j.transcript || "");
      } else {
        chatPlain(j.transcript || "");
      }
    } catch (e) {
      transcriptEl.textContent = "⚠️ STT error: " + e.message;
      processingTurn = false;
      if (auto) setState(SM.LISTEN);
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
function abortStream(){ if (streamCtl){ streamCtl.abort(); streamCtl=null; } streamOn=false; stopBtn.disabled=true; }

async function chatPlain(prompt){
  abortStream();
  stopAudio();
  setState(SM.REPLY); setStatus("thinking…"); setLatency(null,null);
  try{
    const r = await fetch("/api/chat", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ message: prompt }) });
    const j = await r.json();
    if (!r.ok){ replyEl.textContent = `⚠️ ${j.error || "chat error"}`; if (auto) startListening(); else setState(SM.IDLE); return; }
    replyEl.textContent = j.reply || "";
    speak(j.reply || "");
  }catch(e){
    replyEl.textContent = `⚠️ ${e.message}`;
    if (auto) startListening(); else setState(SM.IDLE);
  }
}

async function chatStream(prompt){
  abortStream();
  stopAudio();
  setState(SM.REPLY); setStatus("streaming…"); setLatency(null,null);
  stopBtn.disabled=false;

  const t0 = performance.now();
  let tFirst = null;
  let full = "";
  streamCtl = new AbortController();
  streamOn = true;

  try{
    const resp = await fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ message: prompt, history: [] }),
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
          if (tok){ full += tok; replyEl.textContent = full; }
        }catch{
          full += payload; replyEl.textContent = full;
        }
      }
    }
  }catch(e){
    if (e.name !== "AbortError"){ replyEl.textContent = `⚠️ ${e.message}`; }
  }finally{
    const tTot = Math.round(performance.now() - t0);
    setLatency(tFirst ?? null, tTot);
    streamOn=false; stopBtn.disabled=true; setStatus("idle");
  }

  if (full) speak(full); else if (auto) startListening();
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

    const thr     = (Number(vadEl.value) || 35) / 3000;               // slider → ~0.0..0.05
    const silence = Math.max(200, Math.min(4000, Number(silenceEl.value) || 700));

    const micRms = rmsFromAnalyser(micAnalyser);
    const outRms = rmsFromAnalyser(outAnalyser);
    outEma = ema(outEma, outRms, 0.2);

    const now = performance.now();
    const graceActive = (sm === SM.SPEAK) && (now - speakStartedAt < TTS_GRACE_MS);

    // Only gate vs output while audio is playing; otherwise just compare to threshold
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

    // If we were recording and user went quiet long enough, stop to process
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
sendBtn.addEventListener("click", () => {
  const t = (msgEl.value || "").trim();
  if (!t) return;
  replyEl.textContent = "";
  transcriptEl.textContent = "–";
  if ((modeSel.value || "").toLowerCase().startsWith("stream")) chatStream(t);
  else chatPlain(t);
  msgEl.value = ""; msgEl.focus();
});

stopBtn.addEventListener("click", () => { abortStream(); stopAudio(); setLatency(null,null); setState(SM.IDLE); });

// Hold-to-talk
pttBtn.addEventListener("mousedown",  () => startRecordingTurn());
pttBtn.addEventListener("touchstart", () => startRecordingTurn(), { passive:true });
pttBtn.addEventListener("mouseup",    () => stopRecordingTurn());
pttBtn.addEventListener("mouseleave", () => stopRecordingTurn());
pttBtn.addEventListener("touchend",   () => stopRecordingTurn());

// Auto-talk toggle
autoBtn.addEventListener("click", async () => {
  auto = !auto;
  autoBtn.textContent = auto ? "🔁 Auto talk: On" : "🔁 Auto talk: Off";
  localStorage.setItem("autoTalk", auto ? "1" : "0");
  if (auto){ await ensureMic(); startListening(); } else { stopListening(); }
});

// Keyboard send
msgEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendBtn.click(); });

// Cache prefs
(function bootPrefs(){
  const e = localStorage.getItem("ttsEngine");   if (e) ttsSel.value = e;
  const v = localStorage.getItem("elevenVoiceId"); if (v) voiceIdEl.value = v;
  const a = localStorage.getItem("autoTalk");    if (a === "1") { auto = true; autoBtn.textContent = "🔁 Auto talk: On"; }
})();
ttsSel.addEventListener("change",  ()=> localStorage.setItem("ttsEngine", ttsSel.value));
voiceIdEl.addEventListener("change", ()=> localStorage.setItem("elevenVoiceId", voiceIdEl.value.trim()));

// Browser voices (for "browser" engine)
function loadVoices(){
  const arr = (window.speechSynthesis?.getVoices?.() || []).filter(v => v.lang?.startsWith?.("en"));
  selectedVoice = arr[0] || null;
}
if ("speechSynthesis" in window){ loadVoices(); window.speechSynthesis.onvoiceschanged = loadVoices; }

/* ---------- Boot ---------- */
(async function boot(){
  try { await ensureMic(); } catch {}
  if (auto) startListening();
  setStatus("idle");
})();
