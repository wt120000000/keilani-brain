// Voice loop with output-aware VAD, sustained onset, grace window, and SSE streaming

// ---- DOM
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const pttBtn  = document.getElementById("ptt");
const autoBtn = document.getElementById("auto");

const msgEl   = document.getElementById("message");
const replyEl = document.getElementById("reply");
const stateEl = document.getElementById("state");
const statusEl= document.getElementById("status");
const latEl   = document.getElementById("lat");
const transcriptEl = document.getElementById("transcript");
const lastAudio = document.getElementById("lastAudio");

const modeSel = document.getElementById("mode");
const ttsSel  = document.getElementById("ttsEngine");
const voiceIdEl = document.getElementById("voiceId");
const vadEl   = document.getElementById("vad");
const silenceEl = document.getElementById("silence");

// ---- State
const SM = { IDLE:"idle", LISTEN:"listening", REC:"recording", REPLY:"replying", SPEAK:"speaking", PROCESS:"processing" };
let sm = SM.IDLE;
let auto = false;

let currentAudio = null;
let streamCtl = null;
let streamOn = false;

let mediaStream = null;
let mediaRecorder = null;
let audioCtx = null;
let micAnalyser = null;
let outAnalyser = null;
let micSource = null;
let outSource = null;
let listenLoopOn = false;
let processingTurn = false;

let voices = [];
let selectedVoice = null;
let ttsOn = true;

let speakStartedAt = 0;

// ---- Helpers
const setState = s => { sm = s; stateEl.textContent = "state: " + s; };
const setStatus = s => { statusEl.firstChild.nodeValue = s + " "; };
const setLatency = (first, total) => { latEl.textContent = `${first!=null?`• first ${first} ms `:""}${total!=null?`• total ${total} ms`:""}`; };

function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;"," >":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}
function ema(prev, next, alpha){ return prev === null ? next : (alpha*next + (1-alpha)*prev); }

// ---- Audio / TTS
function stopAudio(){
  if (currentAudio){ currentAudio.pause(); currentAudio.src=""; currentAudio=null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

async function speak(text){
  if (!ttsOn || !text) { if (auto) startListening(); else setState(SM.IDLE); return; }
  setState(SM.SPEAK);
  speakStartedAt = performance.now();

  if (ttsSel.value === "browser"){
    if (!("speechSynthesis" in window)) { if (auto) startListening(); else setState(SM.IDLE); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (selectedVoice) u.voice = selectedVoice;
    u.onend = ()=> { if (auto) startListening(); else setState(SM.IDLE); };
    window.speechSynthesis.speak(u);
    return;
  }
  try {
    const r = await fetch("/.netlify/functions/tts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ text, voiceId: voiceIdEl.value.trim()||undefined })});
    const data = await r.json();
    if (!r.ok || !data?.audio){ if (auto) startListening(); else setState(SM.IDLE); return; }
    if (typeof data.audio === "string" && data.audio.startsWith("data:audio")){
      currentAudio = new Audio(data.audio);
      wireOutputAnalyser(currentAudio);
      currentAudio.onended = ()=> { if (auto) startListening(); else setState(SM.IDLE); };
      currentAudio.play().catch(()=>{ if (auto) startListening(); else setState(SM.IDLE); });
      lastAudio.src = data.audio;
    } else {
      if (auto) startListening(); else setState(SM.IDLE);
    }
  } catch {
    if (auto) startListening(); else setState(SM.IDLE);
  }
}

// ---- Streaming chat
function abortStream(){ if (streamCtl){ streamCtl.abort(); streamCtl=null; } streamOn=false; stopBtn.disabled=true; }
async function chatStream(prompt){
  abortStream(); stopAudio();
  setState(SM.REPLY); setStatus("streaming…"); setLatency(null,null);
  stopBtn.disabled=false;

  const t0=performance.now(); let tFirst=null; let full="";
  streamCtl=new AbortController(); streamOn=true;

  try{
    const resp=await fetch("/api/chat-stream",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:prompt,history:[]}),signal:streamCtl.signal});
    if(!resp.ok||!resp.body) throw new Error(`stream ${resp.status}`);
    const dec=new TextDecoder(); const reader=resp.body.getReader(); let buf="";
    while(true){
      const {value,done}=await reader.read(); if(done) break;
      buf+=dec.decode(value,{stream:true});
      const lines=buf.split(/\r?\n/); buf=lines.pop()||"";
      for(const line of lines){
        const l=line.trim(); if(!l||l.startsWith(":")) continue;
        if(l==="data: [DONE]"||l==="[DONE]"){ buf=""; break; }
        const payload=l.startsWith("data:")?l.slice(5).trim():l;
        if(tFirst==null){ tFirst=Math.round(performance.now()-t0); setLatency(tFirst,null); }
        try{
          const j=JSON.parse(payload);
          const tok=j?.choices?.[0]?.delta?.content ?? j?.content ?? "";
          if(tok){ full+=tok; replyEl.textContent=full; }
        }catch{
          full+=payload; replyEl.textContent=full;
        }
      }
    }
  }catch(e){
    if(e.name!=="AbortError"){ replyEl.textContent=`⚠️ ${e.message}`; }
  }finally{
    const tTot=Math.round(performance.now()-t0); setLatency(tFirst??null,tTot);
    streamOn=false; stopBtn.disabled=true; setStatus("idle");
  }
  if(full) speak(full); else if(auto) startListening();
}

async function chatPlain(prompt){
  abortStream(); stopAudio();
  setState(SM.REPLY); setStatus("thinking…"); setLatency(null,null);
  try{
    const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:prompt})});
    const j=await r.json();
    if(!r.ok){ replyEl.textContent=`⚠️ ${j.error||"chat error"}`; if(auto) startListening(); else setState(SM.IDLE); return; }
    replyEl.textContent=j.reply||"";
    speak(j.reply||"");
  }catch(e){
    replyEl.textContent=`⚠️ ${e.message}`; if(auto) startListening(); else setState(SM.IDLE);
  }
}

// ---- Send / stop
sendBtn.addEventListener("click", ()=> {
  const t=msgEl.value.trim(); if(!t) return; replyEl.textContent=""; transcriptEl.textContent="–";
  (modeSel.value==="stream"?chatStream:chatPlain)(t);
  msgEl.value=""; msgEl.focus();
});
stopBtn.addEventListener("click", ()=> { abortStream(); stopAudio(); setState(SM.IDLE); setLatency(null,null); });

// ---- Browser voices
function loadVoices(){
  const arr=(window.speechSynthesis?.getVoices?.()||[]).filter(v=>v.lang?.startsWith?.("en"));
  voices=arr; selectedVoice=arr[0]||null;
}
if("speechSynthesis" in window){ loadVoices(); window.speechSynthesis.onvoiceschanged=loadVoices; }

// ---- Manual hold-to-talk
pttBtn.addEventListener("mousedown", ()=> startRecordingTurn());
pttBtn.addEventListener("touchstart", ()=> startRecordingTurn(), {passive:true});
pttBtn.addEventListener("mouseup", ()=> stopRecordingTurn());
pttBtn.addEventListener("mouseleave", ()=> stopRecordingTurn());
pttBtn.addEventListener("touchend", ()=> stopRecordingTurn());

// ---- Auto talk
autoBtn.addEventListener("click", async ()=>{
  auto=!auto;
  autoBtn.textContent=auto?"🔁 Auto talk: On":"🔁 Auto talk: Off";
  autoBtn.classList.toggle("ghost",true);
  if(auto){ await ensureMic(); startListening(); } else { stopListening(); }
});

// ---- Mic / VAD (output-aware)
async function ensureMic(){
  if(mediaStream) return;
  mediaStream=await navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
  });
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  micSource = audioCtx.createMediaStreamSource(mediaStream);
  micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize=2048;
  micSource.connect(micAnalyser);
}

function wireOutputAnalyser(audioEl){
  if(!audioCtx) return;
  try{
    outSource = audioCtx.createMediaElementSource(audioEl);
    outAnalyser = audioCtx.createAnalyser(); outAnalyser.fftSize=2048;
    outSource.connect(outAnalyser);
    // Also send to destination so we can hear it
    outSource.connect(audioCtx.destination);
  }catch{ /* MediaElementSource can be created once per element; safe to ignore */ }
}

function rmsFromAnalyser(an){
  const buf=new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(buf);
  let sum=0; for(let i=0;i<buf.length;i++){ const v=(buf[i]-128)/128; sum+=v*v; }
  return Math.sqrt(sum/buf.length);
}

function startListening(){
  if(!mediaStream) return;
  listenLoopOn = true;
  setState(SM.LISTEN);

  // onset must be sustained across N frames to count as speech
  const REQUIRED_ONSET_FRAMES = 6; // ~180ms @ 60fps
  let onsetFrames = 0;
  let voiced = false;
  let lastSound = performance.now();
  let outEma = null;

  const loop = () => {
    if (!listenLoopOn) return;

    const thr = (Number(vadEl.value)||35)/3000; // mic threshold ~0.003–0.033
    const silence = Math.max(200,Math.min(3000,Number(silenceEl.value)||700));

    const micRms = micAnalyser ? rmsFromAnalyser(micAnalyser) : 0;
    const outRms = outAnalyser ? rmsFromAnalyser(outAnalyser) : 0;
    outEma = ema(outEma, outRms, 0.2); // smooth playback energy

    const now = performance.now();
    const graceActive = (sm===SM.SPEAK) && (now - speakStartedAt < 350); // grace window after TTS starts

    // output-aware margin: require mic > playback + margin
    const margin = 0.02; // tweakable; ~ -34 dBFS
    const micBeatsOutput = micRms > ((outEma||0) + margin);

    // BARGE-IN candidate: only if not in PROCESS and not in grace window
    if (!processingTurn && !graceActive) {
      if (micRms > thr && micBeatsOutput) {
        onsetFrames++;
        if (!voiced && onsetFrames >= REQUIRED_ONSET_FRAMES) {
          // start turn
          stopAudio(); abortStream();
          startRecordingTurn();
          setState(SM.REC);
          voiced = true;
          lastSound = now;
          onsetFrames = 0;
        }
      } else {
        onsetFrames = 0;
      }
    }

    if (voiced) {
      lastSound = now;
    }

    // end of speech -> stop recorder but keep loop alive
    if (voiced && (now - lastSound) > silence) {
      voiced = false;
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        processingTurn = true;
        mediaRecorder.stop();
        setState(SM.PROCESS);
      }
    }

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function stopListening(){
  listenLoopOn=false;
  if(mediaRecorder && mediaRecorder.state!=="inactive") mediaRecorder.stop();
  setState(SM.IDLE);
}

function startRecordingTurn(){
  if(!mediaStream) return;
  abortStream(); stopAudio();

  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
             : MediaRecorder.isTypeSupported("audio/ogg")  ? "audio/ogg"  : "";
  mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
  const chunks=[];
  mediaRecorder.ondataavailable = e => { if(e.data && e.data.size>0) chunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
    if(!blob || blob.size<5000){ transcriptEl.textContent="⚠️ Speak a bit longer."; processingTurn=false; if(auto) setState(SM.LISTEN); return; }
    const dataUrl = await blobToDataUrl(blob);
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:audio")) lastAudio.src = dataUrl;

    try{
      const r=await fetch("/.netlify/functions/stt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({audioBase64:dataUrl,language:"en"})});
      const j=await r.json();
      if(!r.ok){ transcriptEl.textContent=`⚠️ STT: ${j?.error||"error"}`; processingTurn=false; if(auto) setState(SM.LISTEN); return; }
      transcriptEl.textContent=j.transcript||"";
      replyEl.textContent="";
      processingTurn=false;
      (modeSel.value==="stream"?chatStream:chatPlain)(j.transcript||"");
    }catch(e){
      transcriptEl.textContent="⚠️ STT error: "+e.message;
      processingTurn=false;
      if(auto) setState(SM.LISTEN);
    }
  };
  mediaRecorder.start(50);
}

function stopRecordingTurn(){
  if(mediaRecorder && mediaRecorder.state!=="inactive"){ mediaRecorder.stop(); }
}

function blobToDataUrl(blob){
  return new Promise(res=>{ const fr=new FileReader(); fr.onloadend=()=>res(fr.result); fr.readAsDataURL(blob); });
}

// ---- UX niceties
msgEl.addEventListener("keydown", e=>{ if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)) sendBtn.click(); });
document.addEventListener("visibilitychange", ()=>{ if(document.hidden){ abortStream(); } });

// Remember engine / voice id
(function boot(){
  const e=localStorage.getItem("ttsEngine"); if(e) ttsSel.value=e;
  const v=localStorage.getItem("elevenVoiceId"); if(v) voiceIdEl.value=v;
})();
ttsSel.addEventListener("change", ()=> localStorage.setItem("ttsEngine", ttsSel.value));
voiceIdEl.addEventListener("change", ()=> localStorage.setItem("elevenVoiceId", voiceIdEl.value.trim()));
