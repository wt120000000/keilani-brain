/* keilaniStream.js v12
 * - Sleek HUD + speaking orb
 * - Fixes "Invalid URI" spam
 * - Persists prefs (auto, tts, voiceId, VAD, silence, device ids)
 * - Optional Supabase logging via Netlify function /api/log
 */

const $ = id => document.getElementById(id);

/* ---------- DOM ---------- */
const startBtn = $("start");
const stopBtn  = $("stop");
const pttBtn   = $("ptt");
const autoChk  = $("auto");

const ttsSel   = $("ttsEngine");
const voiceIdEl= $("voiceId");
const vadEl    = $("vad");
const silenceEl= $("silence");

const micSel   = $("micSelect");
const outSel   = $("outSelect");

const msgEl    = $("message");
const sendBtn  = $("send");

const transcriptEl = $("transcript");
const replyEl      = $("reply");
const lastAudioEl  = $("lastAudio");

const hudState = $("hud-state");
const hudLat   = $("hud-lat");
const hudLast  = $("hud-last");

const orb = $("speakingOrb");
const orbLabel = $("speakingLabel");

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
let currentAudio = null;   // transient element for playback
let outIsPlaying = false;

let listenLoopOn = false;
let processingTurn = false;

let selectedVoice = null; // browser TTS
let speakStartedAt = 0;

let streamCtl = null;
let streamOn  = false;

let sessionId = localStorage.getItem("k_session") || (Date.now().toString(36) + Math.random().toString(36).slice(2));
localStorage.setItem("k_session", sessionId);

/* ---------- Tunables ---------- */
const REQUIRED_ONSET_FRAMES = 3;
const OUTPUT_MARGIN         = 0.008;
const TTS_GRACE_MS          = 200;

/* ---------- Helpers ---------- */
const setState   = s => { sm=s; hudState.textContent = "state: " + s; updateOrb(); };
const setStatus  = s => { hudLast.textContent = "last: " + s; };
const setLatency = (first,total) => { hudLat.textContent = `• first ${first??"–"} ms • total ${total??"–"} ms`; };

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

function updateOrb(){
  orb.classList.remove("speaking","listening");
  if (sm === SM.SPEAK) { orb.classList.add("speaking"); orbLabel.textContent = "speaking"; return; }
  if (sm === SM.LISTEN || sm === SM.REC) { orb.classList.add("listening"); orbLabel.textContent = sm; return; }
  orbLabel.textContent = "idle";
}

/* ---------- Audio I/O ---------- */
async function listDevices(){
  const devs = await navigator.mediaDevices.enumerateDevices();
  const mics = devs.filter(d=>d.kind==="audioinput");
  const outs = devs.filter(d=>d.kind==="audiooutput");

  const prevMic = localStorage.getItem("k_mic") || "";
  const prevOut = localStorage.getItem("k_out") || "";

  micSel.innerHTML = mics.map(d=>`<option value="${d.deviceId}">${d.label||"Microphone"}</option>`).join("");
  outSel.innerHTML = outs.map(d=>`<option value="${d.deviceId}">${d.label||"System default"}</option>`).join("");

  if (prevMic) micSel.value = prevMic;
  if (prevOut) outSel.value = prevOut;
}

async function ensureMic(){
  if (mediaStream) return;

  const constraints = {
    audio:{
      deviceId: micSel.value ? {exact:micSel.value} : undefined,
      echoCancellation:true, noiseSuppression:true, autoGainControl:true
    }
  };
  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  micSource = audioCtx.createMediaStreamSource(mediaStream);
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 2048;
  micSource.connect(micAnalyser);

  // Rebuild output analyser once per page (safe on Safari: only one MediaElementSource per element)
  if (!outAnalyser){
    outAnalyser = audioCtx.createAnalyser();
    outAnalyser.fftSize = 2048;
  }
}

function wireOutputAnalyser(audioEl){
  if (!audioCtx) return;
  try{
    if (outSource){ try{ outSource.disconnect(); }catch{} outSource = null; }
    outSource = audioCtx.createMediaElementSource(audioEl);
    outSource.connect(outAnalyser);
    outSource.connect(audioCtx.destination);
  }catch{
    // Safari throws if reused; ignore, analyser still holds last connection
  }
}

function stopAudio(){
  if (currentAudio){
    try { currentAudio.pause(); } catch {}
    try { currentAudio.removeAttribute("src"); } catch {}
  }
  currentAudio = null;
  outIsPlaying = false;
}

/* ---------- TTS ---------- */
async function speak(text){
  if (!text) { if (auto) startListening(); else setState(SM.IDLE); return; }

  setState(SM.SPEAK);
  speakStartedAt = performance.now();

  // Browser fallback
  if (ttsSel.value.toLowerCase() === "browser"){
    if (!("speechSynthesis" in window)) { if (auto) startListening(); else setState(SM.IDLE); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (selectedVoice) u.voice = selectedVoice;
    u.onstart = () => { outIsPlaying = true; updateOrb(); };
    u.onend   = () => { outIsPlaying = false; updateOrb(); if (auto) startListening(); else setState(SM.IDLE); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return;
  }

  // ElevenLabs via Netlify function
  try {
    const r = await fetch("/.netlify/functions/tts?debug=1", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ text, voiceId: (voiceIdEl.value || "").trim() || undefined })
    });

    const data = await r.json().catch(()=> ({}));
    // (Fix) Avoid console noise: only try to play if audio string present
    if (!r.ok || !data?.audio) {
      console.warn("TTS fallback:", { http:r.status, errCode:data?.error || data?.detail?.detail?.status, data });
      // gracefully fall back to browser voice so loop never stalls
      if ("speechSynthesis" in window){
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => { if (auto) startListening(); else setState(SM.IDLE); };
        window.speechSynthesis.speak(u);
      } else {
        if (auto) startListening(); else setState(SM.IDLE);
      }
      return;
    }

    if (typeof data.audio === "string" && data.audio.startsWith("data:audio")){
      currentAudio = new Audio(data.audio);
      // assign output device if supported
      const outId = outSel.value;
      if (currentAudio.setSinkId && outId) { try { await currentAudio.setSinkId(outId); } catch{} }
      wireOutputAnalyser(currentAudio);

      currentAudio.addEventListener("playing", ()=>{ outIsPlaying = true; updateOrb(); });
      currentAudio.addEventListener("pause",   ()=>{ outIsPlaying = false; updateOrb(); });
      currentAudio.addEventListener("ended",   ()=>{ outIsPlaying = false; updateOrb(); if (auto) startListening(); else setState(SM.IDLE); });

      try { await currentAudio.play(); } catch { outIsPlaying=false; updateOrb(); if (auto) startListening(); else setState(SM.IDLE); }
      // Only set preview audio when we actually have a source
      try { lastAudioEl.src = data.audio; } catch {}
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

  // barge-in
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
      if (auto) setState(SM.LISTEN); else setState(SM.IDLE);
      return;
    }

    const dataUrl = await blobToDataUrl(blob);
    try { lastAudioEl.src = dataUrl; } catch {}

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
        if (auto) setState(SM.LISTEN); else setState(SM.IDLE);
        return;
      }
      transcriptEl.textContent = j.transcript || "";
      replyEl.textContent = "";
      processingTurn = false;

      if ((modeSelVal() || "stream").startsWith("stream")) {
        chatStream(j.transcript || "");
      } else {
        chatPlain(j.transcript || "");
      }
    } catch (e) {
      transcriptEl.textContent = "⚠️ STT error: " + e.message;
      processingTurn = false;
      if (auto) setState(SM.LISTEN); else setState(SM.IDLE);
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

/* ---------- Chat backends ---------- */
function modeSelVal(){ return "stream"; } // single mode (SSE) for this UI

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
    logTurn(prompt, j.reply || "", {mode:"plain"});
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
    streamOn=false; stopBtn.disabled=true; setStatus("ok");
  }

  if (full) { logTurn(prompt, full, {mode:"stream"}); speak(full); }
  else if (auto) startListening();
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

    const thr     = (Number(vadEl.value) || 35) / 3000;
    const silence = Math.max(200, Math.min(4000, Number(silenceEl.value) || 700));

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

/* ---------- Logging (Supabase via Netlify Function) ---------- */
async function logTurn(user, assistant, meta){
  try {
    await fetch("/api/log", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ sessionId, user, assistant, meta, ts: Date.now() })
    });
  } catch(e){ /* non-fatal */ }
}

/* ---------- UI wiring ---------- */
sendBtn.addEventListener("click", () => {
  const t = (msgEl.value || "").trim();
  if (!t) return;
  replyEl.textContent = "";
  transcriptEl.textContent = "–";
  chatStream(t);
  msgEl.value = ""; msgEl.focus();
});
msgEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendBtn.click(); });

startBtn.addEventListener("click", async () => {
  await ensureMic();
  if (audioCtx?.state === "suspended") { try{ await audioCtx.resume(); }catch{} }
  startListening();
  setStatus("listening…");
});
stopBtn.addEventListener("click", () => { abortStream(); stopAudio(); stopListening(); setLatency(null,null); setStatus("stopped"); });

pttBtn.addEventListener("mousedown",  () => startRecordingTurn());
pttBtn.addEventListener("touchstart", () => startRecordingTurn(), { passive:true });
pttBtn.addEventListener("mouseup",    () => stopRecordingTurn());
pttBtn.addEventListener("mouseleave", () => stopRecordingTurn());
pttBtn.addEventListener("touchend",   () => stopRecordingTurn());

autoChk.addEventListener("change", () => {
  auto = autoChk.checked;
  localStorage.setItem("k_auto", auto ? "1" : "0");
  if (auto){ startBtn.click(); } else { stopListening(); }
});
micSel.addEventListener("change", ()=> { localStorage.setItem("k_mic", micSel.value); mediaStream=null; ensureMic(); });
outSel.addEventListener("change", ()=> { localStorage.setItem("k_out", outSel.value); });

ttsSel.addEventListener("change",  ()=> localStorage.setItem("k_tts", ttsSel.value));
voiceIdEl.addEventListener("change", ()=> localStorage.setItem("k_voice", voiceIdEl.value.trim()));
vadEl.addEventListener("change", ()=> localStorage.setItem("k_vad", String(vadEl.value)));
silenceEl.addEventListener("change", ()=> localStorage.setItem("k_sil", String(silenceEl.value)));

/* ---------- Browser voices ---------- */
function loadVoices(){
  const arr = (window.speechSynthesis?.getVoices?.() || []).filter(v => v.lang?.startsWith?.("en"));
  selectedVoice = arr[0] || null;
}
if ("speechSynthesis" in window){ loadVoices(); window.speechSynthesis.onvoiceschanged = loadVoices; }

/* ---------- Boot ---------- */
(async function boot(){
  // restore prefs
  auto = localStorage.getItem("k_auto") === "1"; autoChk.checked = auto;
  const e = localStorage.getItem("k_tts"); if (e) ttsSel.value = e;
  const v = localStorage.getItem("k_voice"); if (v) voiceIdEl.value = v;
  const vd = localStorage.getItem("k_vad"); if (vd) vadEl.value = vd;
  const si = localStorage.getItem("k_sil"); if (si) silenceEl.value = si;

  try {
    await listDevices();
    if (auto){ await ensureMic(); startListening(); }
  } catch {}

  setStatus("ready");
})();
