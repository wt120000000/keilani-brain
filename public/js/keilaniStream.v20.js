/* keilaniStream.v20.js */
(() => {
  console.log("[keilani] boot v20");

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);

  const startBtn = $("start");
  const stopBtn  = $("stop");
  const pttBtn   = $("ptt");
  const autoChk  = $("auto");

  const modeSel  = $("mode");
  const ttsSel   = $("ttsEngine");
  const voiceIdI = $("voiceId");

  const micSel   = $("mic");
  const spkSel   = $("spk");

  const vadEl    = $("vad");
  const silenceI = $("silence");

  const msgI     = $("message");
  const sendBtn  = $("send");
  const trEl     = $("transcript");
  const rpEl     = $("reply");
  const lastAudio= $("lastAudio");

  const stateEl  = $("state");
  const statusEl = $("status");
  const latEl    = $("lat");

  if (!startBtn || !micSel || !sendBtn) {
    console.error("[keilani] required controls missing");
    return;
  }
  console.log("[keilani] ui wired", {
    hasMic: !!micSel, hasSpk: !!spkSel, hasStart: !!startBtn
  });

  // ---------- Endpoints (with auto-fallback) ----------
  const EP = {
    CHAT_PLAIN : "/api/chat",
    CHAT_STREAM: "/api/chat-stream",
    CHAT_STREAM_FALLBACK: "/.netlify/functions/stream-chat",
    STT        : "/.netlify/functions/stt",
    TTS        : "/.netlify/functions/tts",
    LOG        : "/.netlify/functions/log-turn"
  };

  async function postJSON(url, body, opts={}) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body),
      ...opts
    });
    return r;
  }

  // ---------- State ----------
  const SM = { IDLE:"idle", LISTEN:"listening", REC:"recording", PROC:"processing", REPLY:"replying", SPEAK:"speaking" };
  let sm = SM.IDLE;
  let auto = false;
  let processingTurn = false;
  let listenLoopOn = false;

  let mediaStream = null;
  let mediaRecorder = null;
  let audioCtx = null, micAnalyser = null, outAnalyser = null, outSource = null;
  let currentAudio = null, outIsPlaying = false;
  let selectedVoice = null;
  let speakStartedAt = 0;
  let streamCtl = null;

  // ---------- Utils ----------
  const setState  = (s) => { sm=s; stateEl.textContent = `state: ${s}`; };
  const setStatus = (s) => { statusEl.firstChild ? (statusEl.firstChild.nodeValue=s+" ") : (statusEl.textContent=s); };
  const setLatency= (first,total)=>{ latEl.textContent = `${first!=null?`• first ${first} ms `:""}${total!=null?`• total ${total} ms`:""}`; };

  function ema(prev, next, alpha){ return prev==null? next : alpha*next + (1-alpha)*prev; }
  function rmsFromAnalyser(an){
    if (!an) return 0;
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum=0; for (let i=0;i<buf.length;i++){ const v=(buf[i]-128)/128; sum += v*v; }
    return Math.sqrt(sum/buf.length);
  }
  function blobToDataUrl(blob){
    return new Promise(res => { const fr=new FileReader(); fr.onloadend=()=>res(fr.result); fr.readAsDataURL(blob); });
  }

  // ---------- Devices ----------
  async function ensureMic() {
    if (mediaStream) return;

    const micId = micSel.value || undefined;
    const spkId = spkSel?.value || undefined;

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micId ? { exact: micId } : undefined,
        echoCancellation:true, noiseSuppression:true, autoGainControl:true
      }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    if (spkId && "setSinkId" in HTMLMediaElement.prototype) {
      try { await lastAudio.setSinkId(spkId); } catch {}
    }

    const src = audioCtx.createMediaStreamSource(mediaStream);
    micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize=2048; src.connect(micAnalyser);
  }

  async function listDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const mics = devs.filter(d=>d.kind==="audioinput");
      const spks = devs.filter(d=>d.kind==="audiooutput");

      micSel.innerHTML = ""; mics.forEach(d=>{
        const o=document.createElement("option"); o.value=d.deviceId; o.textContent=d.label||"Microphone"; micSel.appendChild(o);
      });
      if (spkSel) {
        spkSel.innerHTML = ""; spks.forEach(d=>{
          const o=document.createElement("option"); o.value=d.deviceId; o.textContent=d.label||"Speaker"; spkSel.appendChild(o);
        });
      }
    } catch { /* ignore */ }
  }

  // ---------- Audio out analyser ----------
  function wireOutputAnalyser(audioEl){
    if (!audioCtx) return;
    try {
      outSource = audioCtx.createMediaElementSource(audioEl);
      outAnalyser = audioCtx.createAnalyser();
      outAnalyser.fftSize = 2048;
      outSource.connect(outAnalyser);
      outSource.connect(audioCtx.destination);
    } catch { /* Safari reuse throws; ignore */ }
  }
  function stopAudio(){
    if (currentAudio){ try{ currentAudio.pause(); }catch{} currentAudio.src=""; }
    currentAudio=null; outIsPlaying=false;
  }

  // ---------- TTS ----------
  const REQUIRED_ONSET_FRAMES = 3;
  const OUTPUT_MARGIN         = 0.008;
  const TTS_GRACE_MS          = 200;

  async function speak(text){
    if (!text){ if (auto) startListening(); else setState(SM.IDLE); return; }
    setState(SM.SPEAK); speakStartedAt = performance.now();

    if (ttsSel.value === "browser"){
      if (!("speechSynthesis" in window)){ if (auto) startListening(); else setState(SM.IDLE); return; }
      const u=new SpeechSynthesisUtterance(text);
      if (selectedVoice) u.voice=selectedVoice;
      u.onstart = ()=>{ outIsPlaying=true; };
      u.onend   = ()=>{ outIsPlaying=false; if (auto) startListening(); else setState(SM.IDLE); };
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
      return;
    }

    try {
      const r = await postJSON(EP.TTS, { text, voiceId: (voiceIdI.value||"").trim()||undefined });
      const data = await r.json().catch(()=> ({}));
      if (!r.ok || !data?.audio){ if (auto) startListening(); else setState(SM.IDLE); return; }

      if (typeof data.audio === "string" && data.audio.startsWith("data:audio")){
        currentAudio = new Audio(data.audio);
        wireOutputAnalyser(currentAudio);
        currentAudio.addEventListener("playing", ()=>{ outIsPlaying=true; });
        currentAudio.addEventListener("pause",   ()=>{ outIsPlaying=false; });
        currentAudio.addEventListener("ended",   ()=>{ outIsPlaying=false; if (auto) startListening(); else setState(SM.IDLE); });
        try { await currentAudio.play(); } catch { outIsPlaying=false; if (auto) startListening(); else setState(SM.IDLE); }
        lastAudio.src = data.audio;
      } else {
        if (auto) startListening(); else setState(SM.IDLE);
      }
    } catch {
      if (auto) startListening(); else setState(SM.IDLE);
    }
  }

  // ---------- STT turn ----------
  function startRecordingTurn(){
    if (!mediaStream) return;
    abortStream(); stopAudio();

    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
               : MediaRecorder.isTypeSupported("audio/ogg")  ? "audio/ogg"  : "";
    mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType:mime } : undefined);

    const chunks=[];
    mediaRecorder.ondataavailable = (e)=>{ if (e.data && e.data.size>0) chunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      const blob=new Blob(chunks, { type:mime || "application/octet-stream" });
      if (!blob || blob.size < 5000){ trEl.textContent="⚠️ Speak a bit longer."; processingTurn=false; if (auto) setState(SM.LISTEN); return; }

      const dataUrl = await blobToDataUrl(blob);
      if (typeof dataUrl==="string" && dataUrl.startsWith("data:audio")) lastAudio.src = dataUrl;

      try{
        const r = await postJSON(EP.STT, { audioBase64:dataUrl, language:"en" });
        const j = await r.json();
        if (!r.ok){ trEl.textContent=`⚠️ STT: ${j?.error || "error"}`; processingTurn=false; if (auto) setState(SM.LISTEN); return; }
        trEl.textContent = j.transcript || "";
        rpEl.textContent = "";
        processingTurn=false;

        if ((modeSel.value||"").toLowerCase()==="stream") chatStream(j.transcript||"");
        else chatPlain(j.transcript||"");
      }catch(e){
        trEl.textContent = "⚠️ STT error: "+e.message; processingTurn=false; if (auto) setState(SM.LISTEN);
      }
    };

    mediaRecorder.start(50);
    setState(SM.REC);
  }
  function stopRecordingTurn(){
    if (mediaRecorder && mediaRecorder.state !== "inactive"){
      processingTurn = true;
      mediaRecorder.stop();
      setState(SM.PROC);
    }
  }

  // ---------- Chat (plain/stream with fallback) ----------
  function abortStream(){ if (streamCtl){ streamCtl.abort(); streamCtl=null; } }

  async function chatPlain(prompt){
    abortStream(); stopAudio();
    setState(SM.REPLY); setStatus("thinking…"); setLatency(null,null);
    try{
      const r = await postJSON(EP.CHAT_PLAIN, { message:prompt });
      const j = await r.json();
      if (!r.ok){ rpEl.textContent = `⚠️ ${j.error || "chat error"}`; if (auto) startListening(); else setState(SM.IDLE); return; }
      rpEl.textContent = j.reply || "";
      speak(j.reply || "");
    }catch(e){
      rpEl.textContent = `⚠️ ${e.message}`; if (auto) startListening(); else setState(SM.IDLE);
    }
  }

  async function chatStream(prompt){
    abortStream(); stopAudio();
    setState(SM.REPLY); setStatus("streaming…"); setLatency(null,null);

    const t0=performance.now(); let tFirst=null; let full="";
    streamCtl=new AbortController();

    async function tryStream(url){
      const resp = await fetch(url, {
        method:"POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ message:prompt, history:[] }),
        signal: streamCtl.signal
      });
      return resp;
    }

    let resp = await tryStream(EP.CHAT_STREAM);
    if (resp.status===404 || resp.status===405) {
      // fallback to function path
      resp = await tryStream(EP.CHAT_STREAM_FALLBACK);
    }
    if (!resp.ok || !resp.body){ rpEl.textContent = `⚠️ stream ${resp.status}`; setLatency(null, Math.round(performance.now()-t0)); if (auto) startListening(); else setState(SM.IDLE); return; }

    const dec=new TextDecoder(); const reader=resp.body.getReader(); let buf="";
    while(true){
      const {value,done} = await reader.read(); if (done) break;
      buf += dec.decode(value,{stream:true});
      const lines = buf.split(/\r?\n/); buf = lines.pop() || "";
      for (const line of lines){
        const l=line.trim(); if (!l || l.startsWith(":")) continue;
        if (l==="data: [DONE]" || l==="[DONE]"){ buf=""; break; }
        const payload = l.startsWith("data:") ? l.slice(5).trim() : l;

        if (tFirst==null){ tFirst = Math.round(performance.now()-t0); setLatency(tFirst,null); }
        try{
          const j=JSON.parse(payload);
          const tok=j?.choices?.[0]?.delta?.content ?? j?.content ?? "";
          if (tok){ full+=tok; rpEl.textContent=full; }
        }catch{ full+=payload; rpEl.textContent=full; }
      }
    }
    setLatency(tFirst??null, Math.round(performance.now()-t0));
    speak(full);
  }

  // ---------- VAD loop ----------
  function startListening(){
    if (!mediaStream) return;
    listenLoopOn=true; setState(SM.LISTEN);

    let onsetFrames=0, voiced=false, lastSound=performance.now();
    let outEma=null;

    const tick=()=>{
      if (!listenLoopOn) return;

      const thr = (Number(vadEl.value)||35)/3000;
      const silence=Math.max(200, Math.min(4000, Number(silenceI.value)||800));

      const micRms = rmsFromAnalyser(micAnalyser);
      const outRms = rmsFromAnalyser(outAnalyser);
      outEma = ema(outEma, outRms, 0.2);

      const now=performance.now();
      const graceActive = (sm===SM.SPEAK) && (now - speakStartedAt < TTS_GRACE_MS);
      const micBeatsOutput = outIsPlaying ? (micRms > ((outEma||0)+OUTPUT_MARGIN)) : true;

      if (!processingTurn && !graceActive){
        if (micRms > thr && micBeatsOutput){
          onsetFrames++;
          if (!voiced && onsetFrames >= REQUIRED_ONSET_FRAMES){
            stopAudio(); abortStream(); startRecordingTurn();
            voiced=true; lastSound=now; onsetFrames=0;
          }
        } else { onsetFrames=0; }
      }
      if (voiced) lastSound=now;

      if (voiced && (now - lastSound) > silence){
        voiced=false; stopRecordingTurn();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function stopListening(){
    listenLoopOn=false;
    if (mediaRecorder && mediaRecorder.state!=="inactive"){ try{ mediaRecorder.stop(); }catch{} }
    setState(SM.IDLE);
  }

  // ---------- UI wiring ----------
  startBtn.addEventListener("click", async ()=>{
    try{ await ensureMic(); }catch{}
    setStatus("listening…"); startListening();
    stopBtn.disabled=false;
  });
  stopBtn.addEventListener("click", ()=>{ stopListening(); setStatus("idle"); stopBtn.disabled=true; });
  pttBtn.addEventListener("mousedown", ()=> startRecordingTurn());
  pttBtn.addEventListener("mouseup",   ()=> stopRecordingTurn());
  pttBtn.addEventListener("mouseleave",()=> stopRecordingTurn());
  pttBtn.addEventListener("touchstart",()=> startRecordingTurn(), {passive:true});
  pttBtn.addEventListener("touchend",  ()=> stopRecordingTurn());

  sendBtn.addEventListener("click", ()=>{
    const t=(msgI.value||"").trim(); if (!t) return;
    rpEl.textContent=""; trEl.textContent="–";
    if ((modeSel.value||"").toLowerCase()==="stream") chatStream(t); else chatPlain(t);
    msgI.value=""; msgI.focus();
  });
  msgI.addEventListener("keydown", (e)=>{ if (e.key==="Enter" && (e.ctrlKey||e.metaKey)) sendBtn.click(); });

  // prefs + voices
  (function bootPrefs(){
    const e=localStorage.getItem("ttsEngine"); if (e) ttsSel.value=e;
    const v=localStorage.getItem("elevenVoiceId"); if (v) voiceIdI.value=v;
    const a=localStorage.getItem("autoTalk"); if (a==="1"){ auto=true; autoChk.checked=true; }
  })();
  ttsSel.addEventListener("change", ()=> localStorage.setItem("ttsEngine", ttsSel.value));
  voiceIdI.addEventListener("change", ()=> localStorage.setItem("elevenVoiceId", voiceIdI.value.trim()));
  autoChk.addEventListener("change", ()=> { auto=!!autoChk.checked; localStorage.setItem("autoTalk", auto?"1":"0"); if (auto) startListening(); else stopListening(); });

  function loadVoices(){
    const arr=(window.speechSynthesis?.getVoices?.()||[]).filter(v=>v.lang?.startsWith?.("en"));
    selectedVoice = arr[0] || null;
  }
  if ("speechSynthesis" in window){ loadVoices(); window.speechSynthesis.onvoiceschanged=loadVoices; }

  // devices list (best effort)
  navigator.mediaDevices?.getUserMedia?.({audio:true}).then(()=> listDevices()).catch(()=>{});
})();
