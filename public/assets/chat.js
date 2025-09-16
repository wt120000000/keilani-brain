/* public/assets/chat.js
   Keilani Brain — Live
   (…voice, STT, streaming TTS, VAD, telemetry…)
   NEW: session memory (last 10 turns) persisted in localStorage and sent to chat-stream
*/

(() => {
  const $ = (s) => document.querySelector(s);

  // DOM
  const inputEl      = $('#textIn');
  const sendBtn      = $('#sendBtn');
  const speakBtn     = $('#speakBtn');
  const stopBtn      = $('#stopBtn');
  const pttBtn       = $('#pttBtn');
  const voiceSel     = $('#voicePick');
  const transcriptEl = $('#transcriptBox');
  const replyEl      = $('#reply');
  const speaker      = $('#ttsPlayer');
  const micBar       = $('#micBar');
  const micDb        = $('#micDb');
  const vadSlider    = $('#vadThresh');

  // ---------- Toasts ----------
  (function ensureToast() {
    if (document.getElementById('toaster')) return;
    const style = document.createElement('style');
    style.id = 'toast-style';
    style.textContent = `
      #toaster{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:9999}
      .toast{background:#141a22;color:#e6e6e6;border:1px solid #2a3342;border-radius:10px;padding:10px 12px;min-width:220px;max-width:360px;box-shadow:0 6px 24px rgba(0,0,0,.35);font:14px/1.35 system-ui,Segoe UI,Roboto,Helvetica,Arial}
      .toast.ok{border-color:#1f6feb}.toast.warn{border-color:#f2b01e}.toast.err{border-color:#d9534f}
      .toast small{display:block;opacity:.7;margin-top:4px}
    `;
    const host = document.createElement('div');
    host.id = 'toaster';
    document.head.appendChild(style);
    document.body.appendChild(host);
  })();
  function toast(msg, kind='ok', meta=''){const h=$('#toaster');if(!h)return;const el=document.createElement('div');el.className=`toast ${kind}`;el.innerHTML=`<div>${msg}</div>${meta?`<small>${meta}</small>`:''}`;h.appendChild(el);setTimeout(()=>{el.style.opacity='0';el.style.transform='translateY(6px)';},3500);setTimeout(()=>el.remove(),4000);}

  // ---------- Telemetry ----------
  async function sendTelemetry(type, data={}) {
    try {
      await fetch('/.netlify/functions/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ type, ts: new Date().toISOString(), data })
      });
    } catch {}
  }

  const setTxt = (el, t) => { if (el) el.textContent = t; };
  const append = (el, t) => { if (el && t) el.textContent += t; };
  const clear  = (el) => { if (el) el.textContent = ''; };

  // ---------- Voice select ----------
  const VOICE_KEY = 'keilani.voiceId';
  const getVoice = () => (voiceSel?.value || localStorage.getItem(VOICE_KEY) || '').trim();
  const setVoice = (id) => { if (voiceSel){const ok=[...voiceSel.options].some(o=>o.value===id); if(ok) voiceSel.value=id;} localStorage.setItem(VOICE_KEY,id||''); };

  async function loadVoices() {
    if (!voiceSel) return;
    try {
      const r = await fetch('/.netlify/functions/voices');
      const arr = r.ok ? (await r.json()) : [];
      voiceSel.innerHTML = '';
      const opt0 = document.createElement('option');
      opt0.value = ''; opt0.textContent = '(default / no TTS)';
      voiceSel.appendChild(opt0);
      arr.forEach(v => {
        const o = document.createElement('option');
        o.value = v.id || v.voice_id || '';
        o.textContent = `${v.name || 'Voice'}${o.value ? ' ('+o.value.slice(0,6)+'…)' : ''}`;
        voiceSel.appendChild(o);
      });
      const saved = localStorage.getItem(VOICE_KEY) || '';
      if (saved && [...voiceSel.options].some(o => o.value === saved)) {
        voiceSel.value = saved;
      } else {
        const first = [...voiceSel.options].find(o => o.value);
        if (first) voiceSel.value = first.value;
      }
      setVoice(voiceSel.value);
      sendTelemetry('voices_ready', { selected: voiceSel.value || '(server_default)' });
    } catch (e) {
      toast('Could not load voices', 'warn');
      sendTelemetry('voices_error', { message: String(e?.message || e) });
    }
  }
  voiceSel?.addEventListener('change', () => {
    setVoice(voiceSel.value);
    toast('Voice changed', 'ok', voiceSel.options[voiceSel.selectedIndex]?.text || '');
    sendTelemetry('voice_changed', { voice: voiceSel.value });
  });

  // ---------- Audio unlock ----------
  let audioUnlocked = false;
  function unlockAudio(){
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { const ctx = new AC(); if (ctx.state === 'suspended') ctx.resume(); }
      if (speaker) speaker.muted = false;
      audioUnlocked = true;
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  // ---------- Local session history ----------
  const HIST_KEY = 'keilani.history.v1';
  let history = [];
  try { history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { history = []; }
  const pushTurn = (role, text) => {
    if (!text) return;
    history.push({ role, text });
    if (history.length > 20) history = history.slice(-20); // store a little more; server trims to 10
    localStorage.setItem(HIST_KEY, JSON.stringify(history));
  };

  // ---------- TTS (streaming + fallback) ----------
  let ttsAbort=null, mse=null, sourceBuffer=null, mseUrl=null, chunkQ=[];
  let audioEndedResolver = null;

  function resetMSE(){ try{ if(sourceBuffer&&mse&&mse.readyState==='open') sourceBuffer.abort(); }catch{} try{ if(mse&&mse.readyState==='open') mse.endOfStream(); }catch{} sourceBuffer=null; chunkQ=[]; if(mseUrl){URL.revokeObjectURL(mseUrl);mseUrl=null;} mse=null; }
  async function stopSpeaking(){ try{ ttsAbort?.abort(); }catch{} ttsAbort=null; try{ speaker.pause(); }catch{} try{ speaker.removeAttribute('src'); }catch{} resetMSE(); if(audioEndedResolver){audioEndedResolver(); audioEndedResolver=null;} $('#speakLed')?.remove(); sendTelemetry('tts_stop'); }
  async function speakFallback(text, voice){
    try{
      const resp=await fetch('/.netlify/functions/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice:(voice||undefined)})});
      if(!resp.ok){toast('TTS error (fallback)','err',`HTTP ${resp.status}`);return;}
      const ab=await resp.arrayBuffer(); const url=URL.createObjectURL(new Blob([ab],{type:'audio/mpeg'}));
      speaker.src=url; try{ await speaker.play(); }catch{} await new Promise(res=>speaker.addEventListener('ended',res,{once:true})); URL.revokeObjectURL(url);
    }catch{ toast('TTS failed','err'); }
  }
  async function speakStream(text, voice){
    if(!text) return;
    if(!speaker.paused || ttsAbort){ await stopSpeaking(); return; }
    unlockAudio();
    const led=document.createElement('span'); led.id='speakLed'; led.style.cssText='display:inline-block;width:10px;height:10px;margin-left:6px;border-radius:50%;background:#0f0;'; speakBtn?.insertAdjacentElement('afterend',led);
    const canMSE=!!window.MediaSource && MediaSource.isTypeSupported('audio/mpeg'); if(!canMSE){ await speakFallback(text,voice); return; }
    ttsAbort=new AbortController(); const ctrl=ttsAbort;
    mse=new MediaSource(); mseUrl=URL.createObjectURL(mse); speaker.src=mseUrl;
    const endedPromise=new Promise(res=>{audioEndedResolver=res;});
    mse.addEventListener('sourceopen', async ()=>{
      try{ sourceBuffer=mse.addSourceBuffer('audio/mpeg'); }catch(e){ resetMSE(); await speakFallback(text,voice); return; }
      sourceBuffer.addEventListener('updateend',()=>{ if(!sourceBuffer || !chunkQ.length || sourceBuffer.updating) return; const chunk=chunkQ.shift(); try{ sourceBuffer.appendBuffer(chunk);}catch{};});
      let resp; try{
        resp=await fetch('/.netlify/functions/tts-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice:(voice||undefined),latency:3,format:'mp3_44100_128'}),signal:ctrl.signal});
      }catch(e){ resetMSE(); return; }
      if(!resp.ok){ resetMSE(); await speakFallback(text,voice); return; }
      if(!resp.body){ const ab=await resp.arrayBuffer(); const u=URL.createObjectURL(new Blob([ab],{type:'audio/mpeg'})); speaker.src=u; try{ await speaker.play(); }catch{} await new Promise(res=>speaker.addEventListener('ended',res,{once:true})); URL.revokeObjectURL(u); resetMSE(); return; }
      const reader=resp.body.getReader(); speaker.play().catch(()=>{});
      while(true){ const {value,done}=await reader.read(); if(done) break; if(!value||!value.byteLength) continue; const chunk=value.buffer?new Uint8Array(value):new Uint8Array(value); if(sourceBuffer){ if(!sourceBuffer.updating && chunkQ.length===0){ try{ sourceBuffer.appendBuffer(chunk); }catch{ chunkQ.push(chunk);} }else{ chunkQ.push(chunk);} } }
      const end=()=>{ try{ if(mse && mse.readyState==='open') mse.endOfStream(); }catch{} };
      if(!sourceBuffer || !mse) end(); else if(!sourceBuffer.updating && !chunkQ.length) end(); else { const flush=()=>{ sourceBuffer.removeEventListener('updateend',flush); if(!chunkQ.length && !sourceBuffer.updating) end(); }; sourceBuffer.addEventListener('updateend',flush); }
    });
    try{ await speaker.play(); }catch{} await endedPromise; resetMSE(); ttsAbort=null; $('#speakLed')?.remove();
  }

  // ---------- Chat (SSE) ----------
  async function chatStream(message, voice){
    const msg=(message||'').trim(); if(!msg) throw new Error('missing_text');
    clear(replyEl);

    // include short history (server trims to 10)
    const payload = { message: msg, voice, history };

    const resp=await fetch('/api/chat-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!resp.ok || !resp.body){ toast('Chat error','err',`HTTP ${resp.status}`); throw new Error('chat_stream_failed'); }
	
	const resp = await fetch(CHAT_STREAM_URL, {
	  method: "POST",
	  headers: { "Content-Type": "application/json" },
	  body: JSON.stringify({ message, history }),
	});

    const reader=resp.body.getReader(); const dec=new TextDecoder(); let buffer='', final='';
    while(true){
      const {value,done}=await reader.read(); if(done) break;
      buffer += dec.decode(value,{stream:true});
      let idx;
      while((idx=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,idx).trim(); buffer=buffer.slice(idx+1);
        if(!line.startsWith('data:')) continue;
        const data=line.slice(5).trim(); if(!data || data==='[DONE]') continue;
        try{ const obj=JSON.parse(data); const delta=obj.delta ?? obj.content ?? obj.text ?? ''; if(delta){ final+=delta; append(replyEl,delta); } }catch{ final+=data; append(replyEl,data); }
      }
    }
    return final.trim();
  }

  // ---------- STT (guards + single in-flight) ----------
  let mediaStream, mediaRecorder, chunks=[]; let vadActive=false, silenceTimer=null; let sttAbort=null;
  const arrayToBase64=(buf)=>{ let s='',b=new Uint8Array(buf); for(const x of b) s+=String.fromCharCode(x); return btoa(s); };
  const recorderMime=()=> MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus': MediaRecorder.isTypeSupported('audio/webm')?'audio/webm': MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')?'audio/ogg;codecs=opus': MediaRecorder.isTypeSupported('audio/ogg')?'audio/ogg':'audio/webm';
  function updateMeter(p,db){ if(micBar) micBar.style.width=`${Math.max(0,Math.min(100,p))}%`; if(micDb) micDb.textContent=`${db.toFixed(1)} dB`; }

  async function startPTT(){
    await stopSpeaking(); chunks=[]; const mime=recorderMime();
    mediaStream=await navigator.mediaDevices.getUserMedia({audio:true});
    mediaRecorder=new MediaRecorder(mediaStream,{mimeType:mime}); console.log('[PTT] recording… mime=',mime);

    // VAD-lite + meter
    const AC=window.AudioContext||window.webkitAudioContext; const ctx=AC?new AC():null;
    if(ctx){ const src=ctx.createMediaStreamSource(mediaStream); const an=ctx.createAnalyser(); src.connect(an); an.fftSize=512; const data=new Uint8Array(an.fftSize);
      const thresh=()=>{ const v=Number(vadSlider?.value||4); return 0.8+(v-1)*((2.5-0.8)/11); };
      vadActive=true; (function loop(){ if(!vadActive) return; an.getByteTimeDomainData(data); let peak=0,sum=0; for(let i=0;i<data.length;i++){ const d=Math.abs(data[i]-128); if(d>peak) peak=d; sum+=d*d;} const rms=Math.sqrt(sum/data.length); const db=20*Math.log10((rms||1)/64); const pct=Math.min(100,(peak/64)*100); updateMeter(pct,db); if(rms<thresh()){ if(!silenceTimer) silenceTimer=setTimeout(stopPTT,1100);} else { if(silenceTimer){clearTimeout(silenceTimer); silenceTimer=null;} } requestAnimationFrame(loop); })(); }

    mediaRecorder.ondataavailable=(e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop=onPTTStop;
    mediaRecorder.start(250);
  }
  async function stopPTT(){ vadActive=false; if(silenceTimer){clearTimeout(silenceTimer); silenceTimer=null;} updateMeter(0,0); if(mediaRecorder&&mediaRecorder.state==='recording') mediaRecorder.stop(); if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; } }
  async function onPTTStop(){
    if(!chunks.length){ setTxt(transcriptEl,'(no audio captured)'); return; }
    const blob=new Blob(chunks,{type:mediaRecorder?.mimeType||'audio/webm'});

    // STRONGER GUARD: skip STT if <16 KB
    if(blob.size < 16*1024){ setTxt(transcriptEl,'(no speech)'); return; }

    const ab=await blob.arrayBuffer(); const baseMime=(blob.type||'audio/webm').split(';')[0]; const dataUrl=`data:${baseMime};base64,${arrayToBase64(ab)}`;

    try{ sttAbort?.abort(); }catch{} sttAbort=new AbortController();

    let resp, raw, json={};
    try{
      resp=await fetch('/.netlify/functions/stt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audioBase64:dataUrl,language:'en'}),signal:sttAbort.signal});
      raw=await resp.text().catch(()=> ''); try{ json=JSON.parse(raw);}catch{}
    }catch(e){ if(e?.name!=='AbortError'){ toast('Speech recognition failed','err',String(e?.message||e)); } return; }

    if(!resp.ok){ setTxt(transcriptEl,'(stt error)'); toast('Speech recognition failed','err',`HTTP ${resp.status}`); return; }
    const transcript=(json.transcript||'').trim(); setTxt(transcriptEl, transcript || '(no speech)'); if(!transcript) return;

    // Add to history and request
    pushTurn('user', transcript);
    const reply=await chatStream(transcript, getVoice());
    pushTurn('assistant', reply);

    try{ await speakStream(reply, getVoice()); }catch{ await speakFallback(reply, getVoice()); }
  }

  // ---------- Handlers ----------
  async function handleSend(){
    await stopSpeaking();
    const text=inputEl.value.trim(); if(!text) return;
    pushTurn('user', text);
    const reply=await chatStream(text, getVoice());
    pushTurn('assistant', reply);
    try{ await speakStream(reply, getVoice()); }catch{ await speakFallback(reply, getVoice()); }
  }
  async function handleSpeak(){
    const text=(replyEl?.textContent?.trim() || inputEl?.value?.trim() || ''); if(!text) return;
    try{ await speakStream(text, getVoice()); }catch{ await speakFallback(text, getVoice()); }
  }

  // ---------- Wire UI ----------
  sendBtn?.addEventListener('click', handleSend);
  speakBtn?.addEventListener('click', handleSpeak);
  stopBtn?.addEventListener('click', stopSpeaking);

  pttBtn?.addEventListener('pointerdown', startPTT);
  pttBtn?.addEventListener('pointerup', stopPTT);
  pttBtn?.addEventListener('pointerleave', stopPTT);

  window.addEventListener('keydown',(e)=>{ if(e.code==='Space'&&!e.repeat){ e.preventDefault(); startPTT(); } if(e.key?.toLowerCase()==='s'){ e.preventDefault(); stopSpeaking(); } if(e.key==='Enter' && e.target===inputEl && !e.shiftKey){ e.preventDefault(); handleSend(); }});
  window.addEventListener('keyup',(e)=>{ if(e.code==='Space'){ e.preventDefault(); stopPTT(); }});

  // ---------- Init ----------
  loadVoices().finally(()=>{
    console.log('[Keilani] chat.js ready (streaming TTS + voices + telemetry + memory)');
    toast('Ready', 'ok');
    sendTelemetry('client_ready');
  });
})();
