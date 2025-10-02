/* keilaniStream.js (v19) */

const q = (id) => document.getElementById(id);
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
const setTxt = (el, s) => { if (el) el.textContent = s; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const now = () => performance.now();

let startBtn, stopBtn, pttBtn, autoChk;
let sendBtn, msgEl;
let replyEl, transcriptEl, lastAudioEl;
let modeSel, ttsSel, voiceIdEl;
let vadEl, silenceEl, hudState, hudStatus, hudLat;
let micSel, spkSel;

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
let streamOn = false;

const REQUIRED_ONSET_FRAMES = 3;
const OUTPUT_MARGIN         = 0.008;
const TTS_GRACE_MS          = 220;

function setState(s){ sm = s; setTxt(hudState, `state: ${s}`); }
function setStatus(s){ if (!hudStatus) return; hudStatus.firstChild ? hudStatus.firstChild.nodeValue = s + " " : setTxt(hudStatus, s); }
function setLatency(first, total){
  if (!hudLat) return;
  const a = (first!=null) ? `• first ${first} ms ` : "";
  const b = (total!=null) ? `• total ${total} ms` : "";
  setTxt(hudLat, `${a}${b}` || "—");
}

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

async function enumerateDevices(){
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d=>d.kind==="audioinput");
    const outs = devices.filter(d=>d.kind==="audiooutput");

    if (micSel){
      const current = micSel.value;
      micSel.innerHTML = "";
      for (const d of mics){
        const opt = document.createElement("option");
        opt.value = d.deviceId || "";
        opt.textContent = d.label || `Microphone ${micSel.length+1}`;
        micSel.appendChild(opt);
      }
      if (current) micSel.value = current;
    }
    if (spkSel){
      const current = spkSel.value;
      spkSel.innerHTML = "";
      for (const d of outs){
        const opt = document.createElement("option");
        opt.value = d.deviceId || "";
        opt.textContent = d.label || `Speaker ${spkSel.length+1}`;
        spkSel.appendChild(opt);
      }
      if (current) spkSel.value = current;
    }
  }catch(e){
    console.warn("enumerateDevices()", e);
  }
}

async function ensureMic(){
  // Don’t ever touch micSel without guards
  const chosenId = (micSel && typeof micSel.value === "string" && micSel.value.length) ? micSel.value : undefined;

  const constraints = {
    audio: {
      ...(chosenId ? { deviceId: { exact: chosenId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };

  // Close previous
  if (mediaStream){
    try { mediaStream.getTracks().forEach(t=>t.stop()); } catch {}
    mediaStream = null;
  }

  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  micSource = audioCtx.createMediaStreamSource(mediaStream);
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 2048;
  micSource.connect(micAnalyser);

  if (spkSel && lastAudioEl && typeof lastAudioEl.setSinkId === "function" && spkSel.value){
    try { await lastAudioEl.setSinkId(spkSel.value); } catch(e){ console.warn("setSinkId", e); }
  }
}

function wireOutputAnalyser(audioEl){
  if (!audioCtx || !audioEl) return;
  try {
    outSource = audioCtx.createMediaElementSource(audioEl);
    outAnalyser = audioCtx.createAnalyser();
    outAnalyser.fftSize = 2048;
    outSource.connect(outAnalyser);
    outSource.connect(audioCtx.destination);
  } catch { /* one MediaElementSource per element limit */ }
}

function stopAudio(){
  if (currentAudio){
    try { currentAudio.pause(); } catch {}
  }
  currentAudio = null;
  outIsPlaying = false;
}

async function speak(text){
  if (!text){ if (auto) startListening(); else setState(SM.IDLE); return; }

  setState(SM.SPEAK);
  speakStartedAt = now();

  if (ttsSel && ttsSel.value === "browser"){
    if (!("speechSynthesis" in window)) { if (auto) startListening(); else setState(SM.IDLE); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (selectedVoice) u.voice = selectedVoice;
    u.onstart = () => { outIsPlaying = true; };
    u.onend   = () => { outIsPlaying = false; if (auto) startListening(); else setState(SM.IDLE); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return;
  }

  try {
    const body = {
      text,
      voiceId: (voiceIdEl && voiceIdEl.value ? voiceIdEl.value.trim() : undefined) || undefined,
      model_id: "eleven_turbo_v2"
    };
    const r = await fetch("/.netlify/functions/tts", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });

    let data = null;
    try { data = await r.clone().json(); } catch {}
    if (!r.ok || !data || !data.audio){
      console.warn("TTS fallback:", { http: r.status, data });
      if (ttsSel && ttsSel.value !== "browser" && "speechSynthesis" in window){
        const u = new SpeechSynthesisUtterance(text);
        u.onstart = () => { outIsPlaying = true; };
        u.onend   = () => { outIsPlaying = false; if (auto) startListening(); else setState(SM.IDLE); };
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } else {
        if (auto) startListening(); else setState(SM.IDLE);
      }
      return;
    }

    if (typeof data.audio === "string" && data.audio.startsWith("data:audio")){
      currentAudio = new Audio();
      currentAudio.src = data.audio;
      wireOutputAnalyser(currentAudio);
      currentAudio.addEventListener("playing", ()=>{ outIsPlaying=true; });
      currentAudio.addEventListener("pause",   ()=>{ outIsPlaying=false; });
      currentAudio.addEventListener("ended",   ()=>{ outIsPlaying=false; if (auto) startListening(); else setState(SM.IDLE); });
      try { await currentAudio.play(); } catch { outIsPlaying=false; if (auto) startListening(); else setState(SM.IDLE); }
      if (lastAudioEl && data.audio.startsWith("data:audio")) lastAudioEl.src = data.audio;
    } else {
      if (auto) startListening(); else setState(SM.IDLE);
    }
  } catch (e) {
    console.warn("TTS exception:", e);
    if (auto) startListening(); else setState(SM.IDLE);
  }
}

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
    if (!blob || blob.size < 5000) {
      setTxt(transcriptEl, "⚠️ Speak a bit longer.");
      processingTurn = false;
      if (auto) setState(SM.LISTEN);
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
        setTxt(transcriptEl, `⚠️ STT: ${j?.error || "error"}`);
        processingTurn = false;
        if (auto) setState(SM.LISTEN);
        return;
      }
      setTxt(transcriptEl, j.transcript || "");
      setTxt(replyEl, "");
      processingTurn = false;

      if ((modeSel?.value || "").toLowerCase().startsWith("stream")) {
        chatStream(j.transcript || "");
      } else {
        chatPlain(j.transcript || "");
      }
    } catch (e) {
      setTxt(transcriptEl, "⚠️ STT error: " + e.message);
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

function abortStream(){ if (streamCtl){ streamCtl.abort(); streamCtl=null; } streamOn=false; if (stopBtn) stopBtn.disabled=true; }

async function chatPlain(prompt){
  abortStream();
  stopAudio();
  setState(SM.REPLY); setStatus("thinking…"); setLatency(null,null);
  try{
    const r = await fetch("/api/chat", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ message: prompt }) });
    const j = await r.json();
    if (!r.ok){ setTxt(replyEl, `⚠️ ${j.error || "chat error"}`); if (auto) startListening(); else setState(SM.IDLE); return; }
    setTxt(replyEl, j.reply || "");
    speak(j.reply || "");
  }catch(e){
    setTxt(replyEl, `⚠️ ${e.message}`);
    if (auto) startListening(); else setState(SM.IDLE);
  }
}

async function chatStream(prompt){
  abortStream();
  stopAudio();
  setState(SM.REPLY); setStatus("streaming…"); setLatency(null,null);
  if (stopBtn) stopBtn.disabled=false;

  const t0 = now();
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

        if (tFirst == null){ tFirst = Math.round(now() - t0); setLatency(tFirst, null); }

        try{
          const j = JSON.parse(payload);
          const tok = j?.choices?.[0]?.delta?.content ?? j?.content ?? "";
          if (tok){ full += tok; setTxt(replyEl, full); }
        }catch{
          full += payload; setTxt(replyEl, full);
        }
      }
    }
  }catch(e){
    if (e.name !== "AbortError"){ setTxt(replyEl, `⚠️ ${e.message}`); }
  }finally{
    const tTot = Math.round(now() - t0);
    setLatency(tFirst ?? null, tTot);
    streamOn=false; if (stopBtn) stopBtn.disabled=true; setStatus("idle");
  }

  if (full) speak(full); else if (auto) startListening();
}

function startListening(){
  if (!mediaStream) return;
  listenLoopOn = true;
  setState(SM.LISTEN);

  let onsetFrames = 0;
  let voiced = false;
  let lastSound = now();
  let outEma = null;

  const tick = () => {
    if (!listenLoopOn) return;

    const thr     = ((Number(vadEl?.value) || 35)) / 3000;
    const silence = clamp(Number(silenceEl?.value) || 800, 200, 4000);

    const micRms = rmsFromAnalyser(micAnalyser);
    const outRms = rmsFromAnalyser(outAnalyser);
    outEma = ema(outEma, outRms, 0.2);

    const t = now();
    const graceActive = (sm === SM.SPEAK) && (t - speakStartedAt < TTS_GRACE_MS);
    const micBeatsOutput = outIsPlaying ? (micRms > ((outEma || 0) + OUTPUT_MARGIN)) : true;

    if (!processingTurn && !graceActive){
      if (micRms > thr && micBeatsOutput){
        onsetFrames++;
        if (!voiced && onsetFrames >= REQUIRED_ONSET_FRAMES){
          stopAudio();
          abortStream();
          startRecordingTurn();
          voiced = true;
          lastSound = t;
          onsetFrames = 0;
        }
      } else {
        onsetFrames = 0;
      }
    }

    if (voiced) lastSound = t;

    if (voiced && (t - lastSound) > silence){
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

function loadVoices(){
  const arr = (window.speechSynthesis?.getVoices?.() || []).filter(v => v.lang?.startsWith?.("en"));
  selectedVoice = arr[0] || null;
}

async function boot(){
  startBtn      = q("start");
  stopBtn       = q("stop");
  pttBtn        = q("ptt");
  autoChk       = q("auto");
  sendBtn       = q("send");
  msgEl         = q("message");

  replyEl       = q("reply");
  transcriptEl  = q("transcript");
  lastAudioEl   = q("lastAudio");

  modeSel       = q("mode");
  ttsSel        = q("ttsEngine");
  voiceIdEl     = q("voiceId");

  vadEl         = q("vad");
  silenceEl     = q("silence");
  hudState      = q("state");
  hudStatus     = q("status");
  hudLat        = q("lat");

  micSel        = q("mic");
  spkSel        = q("spk");

  setStatus("idle");
  setState(SM.IDLE);

  try {
    const e = localStorage.getItem("ttsEngine");     if (e && ttsSel) ttsSel.value = e;
    const v = localStorage.getItem("elevenVoiceId"); if (v && voiceIdEl) voiceIdEl.value = v;
    const a = localStorage.getItem("autoTalk");
    if (a === "1" && autoChk){ autoChk.checked = true; auto = true; }
  } catch {}

  on(startBtn, "click", async () => {
    try {
      await ensureMic();           // Safe even if micSel is missing
      if (!listenLoopOn) startListening();
      setStatus("listening…");
    } catch (e) {
      console.warn("start ensureMic()", e);
    }
  });

  on(stopBtn, "click", () => { abortStream(); stopAudio(); setLatency(null,null); stopListening(); setStatus("idle"); });

  on(pttBtn, "mousedown",  () => startRecordingTurn());
  on(pttBtn, "touchstart", () => startRecordingTurn(), { passive:true });
  on(pttBtn, "mouseup",    () => stopRecordingTurn());
  on(pttBtn, "mouseleave", () => stopRecordingTurn());
  on(pttBtn, "touchend",   () => stopRecordingTurn());

  on(autoChk, "change", async () => {
    auto = !!autoChk.checked;
    localStorage.setItem("autoTalk", auto ? "1" : "0");
    if (auto){ await ensureMic(); startListening(); } else { stopListening(); }
  });

  on(sendBtn, "click", () => {
    const t = (msgEl?.value || "").trim();
    if (!t) return;
    setTxt(replyEl, "");
    setTxt(transcriptEl, "–");
    if ((modeSel?.value || "").toLowerCase().startsWith("stream")) chatStream(t);
    else chatPlain(t);
    msgEl.value = ""; msgEl.focus();
  });
  on(msgEl, "keydown", (e) => { if ((e.key === "Enter") && (e.ctrlKey || e.metaKey)) sendBtn?.click(); });

  on(ttsSel, "change",  ()=> localStorage.setItem("ttsEngine", ttsSel.value));
  on(voiceIdEl, "change", ()=> localStorage.setItem("elevenVoiceId", (voiceIdEl.value||"").trim()));

  // Re-open stream when mic changes (guarded)
  on(micSel, "change", async () => {
    try { await ensureMic(); } catch (e){ console.warn("mic change ensureMic()", e); }
  });

  // Rebind speaker for <audio> tag when changed (guarded)
  on(spkSel, "change", async () => {
    if (spkSel && lastAudioEl && typeof lastAudioEl.setSinkId === "function" && spkSel.value){
      try { await lastAudioEl.setSinkId(spkSel.value); } catch(e){ console.warn("setSinkId", e); }
    }
  });

  if (navigator.mediaDevices?.addEventListener){
    navigator.mediaDevices.addEventListener("devicechange", enumerateDevices);
  }

  await enumerateDevices();

  if ("speechSynthesis" in window){
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
