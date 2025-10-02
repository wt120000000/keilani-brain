/* Keilani: keilaniStream.v22.js
   - Output-aware VAD barge-in (stop TTS immediately when user speaks)
   - Grace window after TTS begins (ignore tiny echoes)
   - Quieter aborts (no DOMException noise)
   - Auto-stop recorder on silence without needing the Stop button
   - Minimal memory hooks (calls your Netlify memory endpoints)
*/

(() => {
  console.log("[keilani] boot v22");

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);

  const startBtn   = $("start");
  const stopBtn    = $("stop");
  const pttBtn     = $("ptt");
  const autoChk    = $("auto");
  const modeSel    = $("mode");      // "stream" | "plain"
  const ttsSel     = $("tts");       // "ElevenLabs" | "browser"
  const voiceIdEl  = $("voiceId");
  const micSel     = $("mic");
  const spkSel     = $("spk");
  const vadEl      = $("vad");
  const silenceEl  = $("silence");

  const transcriptEl = $("transcript");
  const replyEl      = $("reply");
  const msgEl        = $("message");

  const hudState = $("hudState");
  const hudLat   = $("hudLat");
  const hudLast  = $("hudLast");

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

  // EMA for output level
  let outEma = null;

  /* ---------- Tunables ---------- */
  const REQUIRED_ONSET_FRAMES = 3;     // frames mic must be hot to start a turn
  const OUTPUT_MARGIN         = 0.008; // how much louder mic must be vs output to barge
  const TTS_GRACE_MS          = 220;   // ignore mic just after TTS begins

  /* ---------- Helpers ---------- */
  const setState = (s) => { sm = s; if (hudState) hudState.textContent = s; };
  const setLatency = (first, total) => { if (hudLat) hudLat.textContent = `${first!=null?`• first ${first} ms `:""}${total!=null?`• total ${total} ms`:""}`; };
  const setLast = (t) => { if (hudLast) hudLast.textContent = t || "ok"; };

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
    if (!mediaStream){
      const devId = (micSel && micSel.value) ? { deviceId:{ exact: micSel.value } } : {};
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true, ...devId }
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      micSource = audioCtx.createMediaStreamSource(mediaStream);
      micAnalyser = audioCtx.createAnalyser();
      micAnalyser.fftSize = 2048;
      micSource.connect(micAnalyser);
    }

    // optional sink (speaker)
    if (spkSel && spkSel.value && HTMLMediaElement.prototype.setSinkId){
      try { (currentAudio||new Audio()).setSinkId(spkSel.value); } catch {}
    }
  }

  function wireOutputAnalyser(audioEl){
    if (!audioCtx) return;
    try {
      outSource = audioCtx.createMediaElementSource(audioEl);
      outAnalyser = audioCtx.createAnalyser();
      outAnalyser.fftSize = 2048;
      outSource.connect(outAnalyser);
      outSource.connect(audioCtx.destination);
    } catch {
      // Safari throws if MediaElementSource reused; ignore
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

    // Browser voice
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

    // ElevenLabs via Netlify function
    try {
      const r = await fetch("/.netlify/functions/tts", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ text, voiceId: (voiceIdEl?.value || "").trim() || undefined })
      });
      const data = await r.json().catch(()=> ({}));
      if (!r.ok || !data?.audio) {
        // fallback silently
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
      } else {
        if (auto) startListening(); else setState(SM.IDLE);
      }
    } catch {
      if (auto) startListening(); else setState(SM.IDLE);
    }
  }

  /* ---------- STT turn ---------- */
  function startRecordingTurn(){
    if (!mediaStream) return;

    // barge in hard: stop anything ongoing
    abortStream();
    stopAudio();

    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
               : MediaRecorder.isTypeSupported("audio/ogg")  ? "audio/ogg" : "";
    mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType:mime } : undefined);

    const chunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
      if (!blob || blob.size < 4000) {
        transcriptEl.value = "⚠️ Speak a bit longer.";
        processingTurn = false;
        if (auto) setState(SM.LISTEN);
        return;
      }

      const dataUrl = await blobToDataUrl(blob);

      try {
        const r = await fetch("/.netlify/functions/stt", {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify({ audioBase64: dataUrl, language: "en" })
        });
        const j = await r.json();
        if (!r.ok) {
          transcriptEl.value = `⚠️ STT: ${j?.error || "error"}`;
          processingTurn = false;
          if (auto) setState(SM.LISTEN);
          return;
        }

        transcriptEl.value = j.transcript || "";
        replyEl.value = "";
        processingTurn = false;

        // memory: capture the user utterance
        upsertMemory({ role:"user", text:j.transcript||"" }).catch(()=>{});

        if ((modeSel?.value || "").toLowerCase().startsWith("stream")) {
          chatStream(j.transcript || "");
        } else {
          chatPlain(j.transcript || "");
        }
      } catch (e) {
        transcriptEl.value = "⚠️ STT error: " + e.message;
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
  function abortStream(){
    try { if (streamCtl){ streamCtl.abort(); } } catch {}
    streamCtl=null; streamOn=false; stopBtn.disabled=true;
  }

  async function chatPlain(prompt){
    abortStream();
    stopAudio();
    setState(SM.REPLY); setLatency(null,null);
    try{
      const r = await fetch("/api/chat", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ message: prompt }) });
      const j = await r.json();
      if (!r.ok){ replyEl.value = `⚠️ ${j.error || "chat error"}`; if (auto) startListening(); else setState(SM.IDLE); return; }
      replyEl.value = j.reply || "";

      // memory: store assistant reply
      upsertMemory({ role:"assistant", text:j.reply||"" }).catch(()=>{});

      speak(j.reply || "");
    }catch(e){
      replyEl.value = `⚠️ ${e.message}`;
      if (auto) startListening(); else setState(SM.IDLE);
    }
  }

  async function chatStream(prompt){
    abortStream();
    stopAudio();
    setState(SM.REPLY); setLatency(null,null);
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
            if (tok){ full += tok; replyEl.value = full; }
          }catch{
            full += payload; replyEl.value = full;
          }
        }
      }
    }catch(e){
      if (e.name !== "AbortError"){ replyEl.value = `⚠️ ${e.message}`; }
    }finally{
      const tTot = Math.round(performance.now() - t0);
      setLatency(tFirst ?? null, tTot);
      streamOn=false; stopBtn.disabled=true;
    }

    if (full) {
      // memory: store assistant reply
      upsertMemory({ role:"assistant", text:full }).catch(()=>{});
      speak(full);
    } else if (auto) startListening();
  }

  /* ---------- VAD loop with output-aware barge-in ---------- */
  function startListening(){
    if (!mediaStream) return;
    listenLoopOn = true;
    setState(SM.LISTEN);

    let onsetFrames = 0;
    let voiced = false;
    let lastSound = performance.now();
    outEma = null;

    const tick = () => {
      if (!listenLoopOn) return;

      const thr     = (Number(vadEl?.value) || 35) / 3000;           // slider → ~0..0.05
      const silence = Math.max(200, Math.min(4000, Number(silenceEl?.value) || 700));

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
            stopAudio();      // barge in: stop TTS immediately
            abortStream();    // cancel any stream
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

  /* ---------- Memory hooks (use your existing Netlify -> Supabase) ---------- */
  const uid = (() => {
    let v = localStorage.getItem("keilani_uid");
    if (!v){ v = crypto.randomUUID(); localStorage.setItem("keilani_uid", v); }
    return v;
  })();

  async function upsertMemory(payload){
    try {
      await fetch("/.netlify/functions/memory-upsert", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ userId: uid, ...payload })
      });
    } catch {}
  }

  async function primeMemory(){
    try {
      await fetch("/.netlify/functions/memory-search", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ userId: uid, query:"greeting", k:3 })
      });
    } catch {}
  }

  /* ---------- UI wiring ---------- */
  function wireUI(){
    if (startBtn) startBtn.addEventListener("click", async () => {
      await ensureMic();
      primeMemory().catch(()=>{});
      startListening();
    });

    if (stopBtn) stopBtn.addEventListener("click", () => { abortStream(); stopAudio(); setLatency(null,null); stopListening(); });

    // Hold-to-talk
    if (pttBtn){
      pttBtn.addEventListener("mousedown",  () => startRecordingTurn());
      pttBtn.addEventListener("touchstart", () => startRecordingTurn(), { passive:true });
      pttBtn.addEventListener("mouseup",    () => stopRecordingTurn());
      pttBtn.addEventListener("mouseleave", () => stopRecordingTurn());
      pttBtn.addEventListener("touchend",   () => stopRecordingTurn());
    }

    // Auto talk (toggle)
    if (autoChk){
      auto = !!autoChk.checked;
      autoChk.addEventListener("change", async () => {
        auto = !!autoChk.checked;
        if (auto){ await ensureMic(); startListening(); } else { stopListening(); }
      });
    }

    // Keyboard send
    if (msgEl){
      msgEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("send")?.click(); });
    }

    // Browser voices (for "browser" engine)
    function loadVoices(){
      const arr = (window.speechSynthesis?.getVoices?.() || []).filter(v => v.lang?.startsWith?.("en"));
      selectedVoice = arr[0] || null;
    }
    if ("speechSynthesis" in window){ loadVoices(); window.speechSynthesis.onvoiceschanged = loadVoices; }

    console.log("[keilani] ui wired ", { hasMic: !!micSel, hasSpk: !!spkSel, hasStart: !!startBtn });
  }

  /* ---------- Boot ---------- */
  (async function boot(){
    try { await ensureMic(); } catch {}
    wireUI();
    setState(SM.IDLE);
  })();

})();
