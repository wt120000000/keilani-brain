/* public/assets/chat.js
   Keilani Brain — Live
   - Streaming OpenAI (server SSE) + streaming ElevenLabs TTS (MediaSource)
   - Barge-in: Speak/PTT can interrupt TTS at any time (Send is the only disabled button while busy)
   - Retries/backoff for chat, STT, TTS
   - Mic meter with safe teardown
*/

(() => {
  // ------- tiny DOM helpers -------
  const $ = (s) => document.querySelector(s);
  const setText = (el, t) => { if (el) el.textContent = t; };
  const append = (el, text) => { if (!el || !text) return; const s = document.createElement('span'); s.textContent = text; el.appendChild(s); };

  // ------- Elements -------
  const inputEl = $('#textIn');
  const voiceSel = $('#voicePick');
  const sendBtn = $('#sendBtn');
  const speakBtn = $('#speakBtn');
  const pttBtn = $('#pttBtn');
  const statusBadge = $('#statePill');
  const stateDot = $('#stateDot');
  const meterBar = $('#micMeter');
  const transcriptEl = $('#transcriptBox');
  const replyEl = $('#reply');
  const speaker = $('#ttsPlayer');

  // ------- State -------
  const State = Object.freeze({ IDLE:'idle', LISTEN:'listening', TRANSCRIBE:'transcribing', THINK:'thinking', SPEAK:'speaking' });
  let state = State.IDLE;
  let chatAbort = null;

  // TTS streaming state
  let ttsAbort = null;
  let mse = null;
  let sourceBuffer = null;
  let chunkQueue = [];
  let mseUrl = null;
  let audioEndedResolver = null;

  // Meter state
  let rafId = null;
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;

  // ------- Utils -------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Only ever disable the Send button; keep Speak/PTT enabled for barge-in
  function setBusySend(isBusy) {
    if (sendBtn) {
      sendBtn.disabled = !!isBusy;
      sendBtn.classList.toggle('btn-busy', !!isBusy);
      sendBtn.setAttribute('aria-disabled', isBusy ? 'true' : 'false');
    }
    if (speakBtn) {
      speakBtn.disabled = false;
      speakBtn.classList.remove('btn-busy');
      speakBtn.removeAttribute('aria-disabled');
    }
    if (pttBtn) {
      pttBtn.disabled = false;
      pttBtn.classList.remove('btn-busy');
      pttBtn.removeAttribute('aria-disabled');
    }
  }

  function setStatus(s) {
    state = s;
    setText(statusBadge, s);

    const hot = (s === State.LISTEN || s === State.TRANSCRIBE);
    if (stateDot) stateDot.classList.toggle('hot', hot);

    const sendIsBusy = (s === State.SPEAK || s === State.THINK || s === State.TRANSCRIBE);
    setBusySend(sendIsBusy);
  }

  async function fetchWithRetry(url, opts={}, { retries=2, baseDelay=400, maxDelay=2000, retryOn=(r)=>r.status===429||r.status>=500 } = {}) {
    let attempt = 0;
    while (true) {
      try {
        const resp = await fetch(url, opts);
        if (!resp.ok && retryOn(resp) && attempt < retries) {
          const delay = Math.min(maxDelay, baseDelay * (2 ** attempt)) + Math.random()*150;
          attempt++; await sleep(delay); continue;
        }
        return resp;
      } catch (e) {
        if (attempt >= retries) throw e;
        const delay = Math.min(maxDelay, baseDelay * (2 ** attempt)) + Math.random()*150;
        attempt++; await sleep(delay);
      }
    }
  }

  // ------- Voices -------
  async function loadVoices() {
    if (!voiceSel) return;
    try {
      voiceSel.innerHTML = '<option value="">(default / no TTS)</option>';
      const resp = await fetch('/.netlify/functions/voices');
      const raw = await resp.text().catch(()=> '');
      let data = {};
      try { data = JSON.parse(raw); } catch {}
      const items = Array.isArray(data?.voices) ? data.voices : Array.isArray(data) ? data : [];
      for (const v of items) {
        const id = v?.voice_id || v?.id || '';
        const name = v?.name || 'Voice';
        if (!id) continue;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${name} (${id.slice(0,6)}…)`;
        voiceSel.appendChild(opt);
      }
      const saved = localStorage.getItem('kb_voice_id') || '';
      if (saved && [...voiceSel.options].some(o => o.value === saved)) voiceSel.value = saved;
      else { const first = [...voiceSel.options].find(o => o.value); if (first) voiceSel.value = first.value; }
      voiceSel.addEventListener('change', () => localStorage.setItem('kb_voice_id', voiceSel.value || ''));
      console.log('[VOICES] ready, selected:', voiceSel.value || '(none)');
    } catch (e) {
      console.warn('[VOICES] load failed', e);
    }
  }
  const getVoice = () => (voiceSel?.value || '').trim();

  // ------- Audio unlock -------
  let audioUnlocked = false;
  function unlockAudioOnce() {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { const ac = new AC(); if (ac.state === 'suspended') ac.resume(); }
      if (speaker) { speaker.muted = false; if (typeof speaker.volume === 'number') speaker.volume = 1.0; }
      audioUnlocked = true;
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudioOnce, { once: true });

  // ------- TTS stop / cleanup (barge-in) -------
  function resetMSE() {
    try { if (sourceBuffer && mse && mse.readyState === 'open') sourceBuffer.abort(); } catch {}
    try { if (mse && mse.readyState === 'open') mse.endOfStream(); } catch {}
    sourceBuffer = null;
    mse = null;
    chunkQueue = [];
    if (mseUrl) { URL.revokeObjectURL(mseUrl); mseUrl = null; }
  }
  async function stopSpeaking() {
    console.log('[TTS] stopSpeaking() — barge in');
    try { if (ttsAbort) ttsAbort.abort(); } catch {}
    ttsAbort = null;
    try { speaker.pause(); } catch {}
    try { speaker.removeAttribute('src'); } catch {}
    resetMSE();
    if (audioEndedResolver) { audioEndedResolver(); audioEndedResolver = null; }
  }

  // ------- TTS: streaming via MediaSource (fallback to /tts) -------
  async function speakStream(text) {
    const voice = getVoice();
    if (!text || !text.trim()) { console.warn('[TTS] no text provided'); return; }
    if (!voice) { console.warn('[TTS] no voice selected, skipping audio'); return; }

    // Toggle stop if already speaking
    if (!speaker.paused || ttsAbort) {
      await stopSpeaking();
      return;
    }

    const canMSE = !!window.MediaSource && MediaSource.isTypeSupported('audio/mpeg');

    // Fallback helper
    const speakFallback = async () => {
      console.warn('[TTS] fallback non-stream /tts (no MSE or error)');
      const resp = await fetchWithRetry('/.netlify/functions/tts', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ text, voice })
      }, { retries: 2 });
      if (!resp.ok) { console.error('[TTS-fallback] HTTP', resp.status); return; }
      const ab = await resp.arrayBuffer();
      const url = URL.createObjectURL(new Blob([ab], { type:'audio/mpeg' }));
      speaker.src = url;
      try { await speaker.play(); } catch (e) { console.warn('[TTS-fallback] autoplay blocked', e); }
      await new Promise(res => speaker.addEventListener('ended', res, { once:true }));
      URL.revokeObjectURL(url);
    };

    if (!canMSE) {
      await speakFallback();
      return;
    }

    console.log('[TTS] streaming via /tts-stream', { voice, len: text.length });

    ttsAbort = new AbortController();
    const ctrl = ttsAbort;

    mse = new MediaSource();
    mseUrl = URL.createObjectURL(mse);
    speaker.src = mseUrl;

    const onEnded = () => { if (audioEndedResolver) { audioEndedResolver(); audioEndedResolver = null; } };
    const endedPromise = new Promise(res => { audioEndedResolver = res; });
    speaker.addEventListener('ended', onEnded, { once: true });

    mse.addEventListener('sourceopen', async () => {
      try { sourceBuffer = mse.addSourceBuffer('audio/mpeg'); }
      catch (e) { console.warn('[MSE] addSourceBuffer failed, falling back:', e); resetMSE(); await speakFallback(); return; }

      sourceBuffer.addEventListener('updateend', () => {
        if (!sourceBuffer || !chunkQueue.length || sourceBuffer.updating) return;
        const chunk = chunkQueue.shift();
        try { sourceBuffer.appendBuffer(chunk); } catch {}
      });

      try {
        const resp = await fetchWithRetry('/.netlify/functions/tts-stream', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ text, voice, latency: 3, format: "mp3_44100_128" }),
          signal: ctrl.signal
        }, { retries: 2 });

        if (!resp.ok || !resp.body) {
          let raw = ''; try { raw = await resp.text(); } catch {}
          console.error('[tts-stream] HTTP', resp.status, raw.slice(0,300));
          resetMSE(); await speakFallback(); return;
        }

        const reader = resp.body.getReader();
        // Start playback ASAP
        speaker.play().catch(()=>{ /* needs gesture; user will click */ });

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || !value.byteLength) continue;
          const chunk = value.buffer ? new Uint8Array(value) : new Uint8Array(value);
          if (sourceBuffer) {
            if (!sourceBuffer.updating && chunkQueue.length === 0) {
              try { sourceBuffer.appendBuffer(chunk); } catch { chunkQueue.push(chunk); }
            } else {
              chunkQueue.push(chunk);
            }
          }
        }

        // finalize
        const finish = () => { try { if (mse && mse.readyState === 'open') mse.endOfStream(); } catch {} };
        if (!sourceBuffer || !mse) finish();
        else if (!sourceBuffer.updating && chunkQueue.length === 0) finish();
        else {
          const onFlush = () => {
            sourceBuffer.removeEventListener('updateend', onFlush);
            if (!chunkQueue.length && !sourceBuffer.updating) finish();
          };
          sourceBuffer.addEventListener('updateend', onFlush);
        }
      } catch (e) {
        if (e?.name !== 'AbortError') console.warn('[tts-stream] fetch error', e);
        resetMSE();
      }
    });

    try { await speaker.play(); } catch {}
    await endedPromise;

    // cleanup
    speaker.removeEventListener('ended', onEnded);
    resetMSE();
    ttsAbort = null;
  }

  // ------- Chat (SSE) + fallback -------
  function clearReply(){ if (replyEl) replyEl.textContent=''; }

  async function chatStreamSSE(message) {
    if (chatAbort) chatAbort.abort();
    chatAbort = new AbortController();

    const msg = (message || '').trim();
    if (!msg) { console.warn('[chat-stream] skipped: empty message'); throw new Error('empty_message'); }

    const resp = await fetchWithRetry('/.netlify/functions/chat-stream', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ message: msg }), signal: chatAbort.signal
    }, { retries: 2 });
    if (!resp.ok || !resp.body) {
      let raw=''; try { raw = await resp.text(); } catch{}
      console.error('[chat-stream] HTTP', resp.status, 'raw=', raw.slice(0,300));
      throw new Error('chat_stream_failed');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer='', finalText='';
    clearReply();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream:true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trimEnd(); buffer = buffer.slice(idx+1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data);
          const chunk = obj.delta ?? obj.content ?? obj.text ?? '';
          if (chunk) { finalText += chunk; append(replyEl, chunk); }
        } catch { finalText += data; append(replyEl, data); }
      }
    }
    return finalText.trim();
  }

  async function chatOnce(message) {
    if (chatAbort) chatAbort.abort();
    chatAbort = new AbortController();

    const msg = (message || '').trim();
    if (!msg) { console.warn('[chat] skipped: empty message'); throw new Error('empty_message'); }

    const resp = await fetchWithRetry('/.netlify/functions/chat', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ message: msg }), signal: chatAbort.signal
    }, { retries: 2 });
    const raw = await resp.text().catch(()=> '');
    if (!resp.ok) { console.error('[chat] HTTP', resp.status, 'raw=', raw.slice(0,300)); throw new Error('chat_failed'); }
    let data={}; try{ data=JSON.parse(raw); }catch{}
    const reply=(data.reply||data.message||data.text||'').trim();
    if(!reply) throw new Error('chat_empty');
    clearReply(); append(replyEl, reply); return reply;
  }

  async function chatSmart(message) {
    try { return await chatStreamSSE(message); }
    catch(e){ console.warn('[chat] fallback:', e?.message||e); return await chatOnce(message); }
  }

  // ------- Send / Speak -------
  async function handleSend() {
    try {
      if (state !== State.IDLE) return;
      unlockAudioOnce();
      await stopSpeaking(); // barge-in if speaking

      const msg = (inputEl?.value || '').trim();
      if (!msg) { console.warn('[SEND] empty input'); return; }

      setStatus(State.THINK);
      const reply = await chatSmart(msg);

      setStatus(State.SPEAK);
      await speakStream(reply);
    } catch(e){ console.error('[SEND]', e); }
    finally { setStatus(State.IDLE); }
  }

  async function handleSpeak() {
    try {
      unlockAudioOnce();
      const text = (replyEl?.textContent?.trim() || inputEl?.value?.trim() || '');
      if (!text) { console.warn('[SPEAK] nothing to say'); return; }
      setStatus(State.SPEAK);
      await speakStream(text); // toggles stop if already speaking
    } catch(e){ console.error('[SPEAK]', e); }
    finally { setStatus(State.IDLE); }
  }

  // ------- Mic meter (safe) -------
  function startMeter(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      sourceNode = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      sourceNode.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        if (!analyser) return; // guard against teardown
        analyser.getByteTimeDomainData(data);
        let peak = 0; for (let i=0;i<data.length;i++){ const v=Math.abs(data[i]-128); if(v>peak) peak=v; }
        const pct = Math.min(100, Math.max(0, (peak / 64) * 100));
        if (meterBar) meterBar.style.width = `${pct}%`;
        rafId = requestAnimationFrame(draw);
      };
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(draw);
    } catch (e) {
      console.warn('[METER] start error', e);
    }
  }
  function stopMeter() {
    try { if (rafId) cancelAnimationFrame(rafId); } catch {}
    rafId = null;
    if (meterBar) meterBar.style.width = '0%';
    try { sourceNode && sourceNode.disconnect(); } catch {}
    try { analyser && analyser.disconnect(); } catch {}
    try { audioCtx && audioCtx.close(); } catch {}
    sourceNode = null; analyser = null; audioCtx = null;
  }

  // ------- PTT flow -------
  let mediaStream=null, mediaRecorder=null, chunks=[], isRecording=false;
  const MIN_BYTES = 4096;

  function recorderMime() {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/ogg')) return 'audio/ogg';
    return 'audio/webm';
  }
  function arrayToBase64(buf){ let b=''; const a=new Uint8Array(buf); for(let i=0;i<a.byteLength;i++) b+=String.fromCharCode(a[i]); return btoa(b); }

  async function startPTT() {
    try {
      // If speaking, barge-in first
      if (!speaker.paused || ttsAbort) await stopSpeaking();

      if (isRecording || state === State.THINK || state === State.SPEAK || state === State.TRANSCRIBE) return;
      unlockAudioOnce(); setStatus(State.LISTEN); isRecording = true; chunks = [];

      const stream = await navigator.mediaDevices.getUserMedia({
        audio:{ channelCount:1, echoCancellation:false, noiseSuppression:false, autoGainControl:false, sampleRate:48000 }
      });
      mediaStream = stream; startMeter(stream);

      const mime = recorderMime();
      mediaRecorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 });
      mediaRecorder.ondataavailable = (e)=>{ if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = onPTTStop;
      mediaRecorder.start(250);
    } catch (e) {
      console.error('[PTT] gUM', e); isRecording = false; setStatus(State.IDLE);
    }
  }
  async function stopPTT() {
    try {
      if (!isRecording) return;
      isRecording = false; stopMeter();
      if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.requestData?.(); mediaRecorder.stop(); }
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    } catch(e){ console.warn('[PTT] stop', e); }
  }
  async function onPTTStop() {
    try {
      setStatus(State.TRANSCRIBE);
      if (!chunks.length) { setText(transcriptEl,'(no audio captured)'); setStatus(State.IDLE); return; }

      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || recorderMime() });
      if (blob.size < MIN_BYTES) { setText(transcriptEl, '(no speech)'); setStatus(State.IDLE); return; }

      const mimeHeader = (blob.type.split(';')[0] || 'audio/webm');
      const ab = await blob.arrayBuffer();
      const dataUrl = `data:${mimeHeader};base64,${arrayToBase64(ab)}`;

      const sttResp = await fetchWithRetry('/.netlify/functions/stt', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl, language:'en' })
      }, { retries: 2 });

      const sttRaw = await sttResp.text().catch(()=> ''); let sttJson={}; try{ sttJson=JSON.parse(sttRaw);}catch{}
      console.log('[PTT] STT', sttResp.status, sttJson);

      if (!sttResp.ok) { setText(transcriptEl, `(stt error ${sttResp.status})`); setStatus(State.IDLE); return; }

      const transcript = (sttJson.transcript || '').trim();
      setText(transcriptEl, transcript || '(no speech)');
      if (!transcript) { setStatus(State.IDLE); return; }

      setStatus(State.THINK);
      const reply = await chatSmart(transcript);

      setStatus(State.SPEAK);
      await speakStream(reply);
    } catch(e){ console.error('[PTT] flow', e); }
    finally { chunks=[]; mediaRecorder=null; mediaStream=null; setStatus(State.IDLE); }
  }

  // ------- Wiring -------
  if (sendBtn)  sendBtn.addEventListener('click', handleSend);
  if (speakBtn) speakBtn.addEventListener('click', handleSpeak);
  if (pttBtn) {
    pttBtn.addEventListener('pointerdown', startPTT);
    pttBtn.addEventListener('pointerup', stopPTT);
    pttBtn.addEventListener('pointerleave', stopPTT);
    pttBtn.addEventListener('mousedown', startPTT);
    pttBtn.addEventListener('mouseup', stopPTT);
    pttBtn.addEventListener('touchstart', (e)=>{ e.preventDefault(); startPTT(); }, { passive:false });
    pttBtn.addEventListener('touchend',   (e)=>{ e.preventDefault(); stopPTT();  }, { passive:false });
  }
  if (inputEl) inputEl.addEventListener('keydown', (e)=>{ if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } });

  setStatus(State.IDLE);
  loadVoices();
  console.log('[Keilani] chat.js ready');
})();
