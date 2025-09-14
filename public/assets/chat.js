/* public/assets/chat.js */

const $ = (id) => document.getElementById(id);

// --- DOM ---
const elTextIn     = $("textIn");
const elSendBtn    = $("sendBtn");
const elSpeakBtn   = $("speakBtn");
const elVoiceSel   = $("voiceSelect");
const elReply      = $("reply");
const elRecBtn     = $("recBtn");
const elRecState   = $("recState");
const elTranscript = $("transcript");
const elAudio      = $("ttsPlayer");

// ========= TTS queue & helpers =========
let speaking = false;
let ttsQueue = [];
let ttsAbort = null;
const spokenSet = new Set();
const SENTENCE_BOUNDARY = /[.!?]\s$/;

const hash = (s)=>{
  let h=2166136261>>>0; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return (h>>>0).toString(36);
};

function getSelectedVoiceId(){ return elVoiceSel?.value || ""; }

function clearTTS(){
  try{ ttsAbort?.abort(); }catch{}
  ttsAbort=null; speaking=false; ttsQueue=[];
  if(elAudio){
    try{
      elAudio.pause();
      elAudio.currentTime=0;
      if(elAudio.src) URL.revokeObjectURL(elAudio.src);
      elAudio.removeAttribute("src");
      elAudio.load();
    }catch{}
  }
}

async function playNext(){
  if(speaking || ttsQueue.length===0) return;
  speaking = true;
  const { text, voiceId } = ttsQueue.shift();
  ttsAbort = new AbortController();

  try{
    const res = await fetch("/api/tts", {
      method:"POST",
      headers:{ "Content-Type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal: ttsAbort.signal
    });
    if(!res.ok) throw new Error(`tts ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    elAudio.onended = () => { try{ URL.revokeObjectURL(url); }catch{} speaking=false; ttsAbort=null; playNext(); };
    elAudio.onerror = () => { try{ URL.revokeObjectURL(url); }catch{} speaking=false; ttsAbort=null; playNext(); };

    elAudio.src = url;
    await elAudio.play().catch(()=>{});
  }catch{
    speaking=false; ttsAbort=null;
  }finally{
    playNext();
  }
}

function enqueueTTS(text, voiceId){
  const t=(text||"").trim(); if(!t) return;
  const sig = hash(t);
  if(spokenSet.has(sig)) return; // de-dupe
  spokenSet.add(sig);
  if(spokenSet.size>200) spokenSet.clear();
  if(ttsQueue.length>6) ttsQueue.shift();
  ttsQueue.push({ text:t, voiceId });
  playNext();
}

function cancelSpeech(){ clearTTS(); }

// ========= SSE chat streaming =========
let currentAbort = null;

async function streamSSE(url, body, handlers){
  if(currentAbort){ try{currentAbort.abort();}catch{} }
  currentAbort = new AbortController();

  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body||{}),
    signal: currentAbort.signal,
  });

  if(!res.ok || !res.body){
    const text = await res.text().catch(()=> "");
    throw new Error(`chat-stream ${res.status}: ${text.slice(0,200)}`);
  }

  handlers.onOpen?.();

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  for(;;){
    const { value, done } = await reader.read();
    if(done) break;

    buf += dec.decode(value, { stream:true });

    let idx;
    while((idx = buf.indexOf("\n\n")) >= 0){
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let event="message", data="";
      for(const line of frame.split("\n")){
        if(line.startsWith("event:")) event=line.slice(6).trim();
        else if(line.startsWith("data:")) data += line.slice(5).trim();
      }

      if(event==="ping" || event==="open") continue;
      if(event==="done"){ handlers.onDone?.(); continue; }
      if(event==="error"){ try{ handlers.onError?.(JSON.parse(data)); }catch{ handlers.onError?.({error:data}); } continue; }

      if(event==="delta"){ // normalized
        try{
          const j=JSON.parse(data);
          if(j?.text) handlers.onPartial?.(j.text);
        }catch{}
        continue;
      }

      // fallback: raw OpenAI chunk
      try{
        const j=JSON.parse(data);
        const delta=j?.choices?.[0]?.delta?.content ?? "";
        if(delta) handlers.onPartial?.(delta);
      }catch{}
    }
  }
}

async function chatStream(userText){
  cancelSpeech();
  if(elReply) elReply.textContent = "";

  const voiceId = getSelectedVoiceId();
  let live = "";

  const onPartial = (piece)=>{
    live += piece;
    if(elReply) elReply.textContent = live;

    // Early speech on sentence boundary
    if(SENTENCE_BOUNDARY.test(live)){
      enqueueTTS(live.trim(), voiceId);
      live = "";
    }
  };

  const onDone = ()=>{
    const tail = live.trim();
    if(tail) enqueueTTS(tail, voiceId);
  };

  const onError = (e)=>{
    if(elReply) elReply.textContent = `⚠ ${e?.error||e?.text||"stream error"}`;
  };

  try{
    await streamSSE("/api/chat-stream", { message: userText }, { onPartial, onDone, onError });
  }catch(err){
    if(elReply) elReply.textContent = `⚠ ${String(err).slice(0,240)}`;
  }finally{
    currentAbort = null;
  }
}

// ========= STT (push-to-talk) =========
let micStream=null, mediaRecorder=null, mediaChunks=[], recording=false, stoppedOnce=false;

const setRecState = (s)=>{ if(elRecState) elRecState.textContent = s; };

function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onloadend=()=> resolve(String(r.result||"").split(",")[1]||"");
    r.onerror=reject; r.readAsDataURL(blob);
  });
}

async function startRecording(){
  cancelSpeech();
  if(recording) return;
  try{
    micStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  }catch{
    setRecState("mic denied");
    return;
  }
  setRecState("recording…"); recording=true; stoppedOnce=false; mediaChunks=[];
  mediaRecorder = new MediaRecorder(micStream, { mimeType:"audio/webm" });

  mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size>0) mediaChunks.push(e.data); };
  mediaRecorder.onstop = async ()=>{
    if(stoppedOnce) return; stoppedOnce=true; recording=false;

    try{
      setRecState("processing…");
      if(!mediaChunks.length) throw new Error("no audio");
      const blob = new Blob(mediaChunks, { type:"audio/webm" });
      const b64  = await blobToBase64(blob);

      const r = await fetch("/api/stt", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ audioBase64: `data:audio/webm;base64,${b64}` })
      });
      const t = await r.text();
      if(!r.ok) throw new Error(t);
      let j={}; try{ j=JSON.parse(t); }catch{}
      const transcript = (j.transcript||"").trim();
      if(elTranscript) elTranscript.textContent = transcript || "(no speech)";
      if(transcript) await chatStream(transcript);
    }catch{
      if(elReply) elReply.textContent = "Couldn’t transcribe. Try again.";
    }finally{
      setRecState("idle");
      try{ micStream?.getTracks()?.forEach(t=>t.stop()); }catch{}
      micStream=null; mediaRecorder=null; mediaChunks=[];
    }
  };

  mediaRecorder.start(150);
}

function stopRecording(){ if(!recording) return; try{ mediaRecorder?.stop(); }catch{} setRecState("idle"); }

// ========= UI wiring =========
elSendBtn?.addEventListener("click", async ()=>{
  const t=(elTextIn?.value||"").trim(); if(!t) return;
  elTextIn.value=""; await chatStream(t);
});

elSpeakBtn?.addEventListener("click", ()=>{
  const t=(elReply?.textContent||"").trim();
  if(t){ cancelSpeech(); enqueueTTS(t, getSelectedVoiceId()); }
});

if(elRecBtn){
  elRecBtn.addEventListener("mousedown", startRecording);
  elRecBtn.addEventListener("mouseup", stopRecording);
  elRecBtn.addEventListener("mouseleave", stopRecording);
  elRecBtn.addEventListener("touchstart", (e)=>{ e.preventDefault(); startRecording(); }, { passive:false });
  elRecBtn.addEventListener("touchend",   (e)=>{ e.preventDefault(); stopRecording(); }, { passive:false });
}

elTextIn?.addEventListener("focus", cancelSpeech);
elTextIn?.addEventListener("input", ()=>{ if((elTextIn.value||"").trim()) cancelSpeech(); });

window.addEventListener("beforeunload", ()=>{ try{currentAbort?.abort();}catch{} cancelSpeech(); });

// ====== (Optional) Populate voices dropdown from your backend list ======
// If you already have /api/voices, uncomment:
//
// fetch("/api/voices").then(r=>r.json()).then(list=>{
//   if(!Array.isArray(list)) return;
//   for(const v of list){
//     const opt=document.createElement("option");
//     opt.value=v.id; opt.textContent=v.name||v.id;
//     elVoiceSel?.appendChild(opt);
//   }
// }).catch(()=>{});
