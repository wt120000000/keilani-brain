/* public/assets/chat.js
   Keilani Brain — Universal mic + Continuous loop (anti-loop guards)
*/

(() => {
  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const inputEl      = $('#textIn')    || $('#input')  || $('textarea');
  const sendBtn      = $('#sendBtn')   || $('#send');
  const speakBtn     = $('#speakBtn')  || $('#speak');
  const pttBtn       = $('#pttBtn')    || $('#ptt') || $('#holdToTalk');
  const voiceSel     = $('#voicePick') || $('#voice') || $('#voiceSelect');
  const statusPill   = $('#statePill') || $('#status') || $('.status');
  const transcriptEl = $('#transcriptBox') || $('#transcript');
  const replyEl      = $('#reply');
  const loopBtn      = $('#chatToggleBtn'); // optional “Start chat” toggle

  // ---------- Session ----------
  const SESSION_KEY = 'kb_session';
  const uuidv4 = () =>
    ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4))).toString(16)
    );
  const getSessionId = () => {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) { id = uuidv4(); localStorage.setItem(SESSION_KEY, id); }
    return id;
  };
  const sessionId = getSessionId();

  // ---------- Audio / TTS ----------
  const player = (() => {
    let el = $('#ttsPlayer') || document.createElement('audio');
    el.id = 'ttsPlayer';
    el.preload = 'none';
    el.controls = true;
    if (!el.parentNode) document.body.appendChild(el);
    return el;
  })();

  let ac = null;
  let bargeIn = { speaking: false };

  function unlockAudioOnce() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!ac && Ctx) ac = new Ctx({ latencyHint: 'interactive' });
      if (ac?.state === 'suspended') ac.resume();
      player.muted = false;
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudioOnce, { once: true });

  const setStatus = (s) => { if (statusPill) statusPill.textContent = s; };
  const getVoice  = () => voiceSel?.value || "";
  const clear     = (el) => { if (el) el.textContent = ''; };
  const append    = (el, t) => { if (!el || !t) return; const s=document.createElement('span'); s.textContent=t; el.appendChild(s); };

  function stopSpeaking() {
    try { player.pause(); player.currentTime = 0; } catch {}
    bargeIn.speaking = false;
  }

  async function speakText(text, voice) {
    if (!text?.trim()) return;
    const resp = await fetch('/.netlify/functions/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!resp.ok) throw new Error('tts_failed');
    const ab = await resp.arrayBuffer();
    const url = URL.createObjectURL(new Blob([ab], { type: 'audio/mpeg' }));
    player.src = url;
    try { bargeIn.speaking = true; await player.play(); } catch {}
  }

  // ---------- Utils ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function fetchWithRetry(url, opts, tries = 2, baseDelay = 250) {
    let last;
    for (let i=0;i<tries;i++) {
      try {
        const resp = await fetch(url, opts);
        if (resp.ok) return resp;
        last = resp;
        // if 4xx, do not hammer; break early
        if (resp.status >= 400 && resp.status < 500) break;
      } catch (e) { last = e; }
      await sleep(baseDelay * Math.pow(2, i));
    }
    if (last && last.text) {
      const raw = await last.text().catch(()=> '');
      throw new Error(`fetch_failed_${last.status || 'net'}:${raw}`);
    }
    throw new Error('fetch_failed');
  }
  const mimeToExt = (m) => {
    if (!m) return 'wav';
    if (m.includes('ogg'))  return 'ogg';
    if (m.includes('webm')) return 'webm';
    if (m.includes('mp3'))  return 'mp3';
    if (m.includes('m4a'))  return 'm4a';
    if (m.includes('wav'))  return 'wav';
    return 'wav';
  };

  // ---------- Chat Stream ----------
  async function chatStream(message, voice) {
    if (!message || !message.trim()) throw new Error('empty_message');
    const resp = await fetchWithRetry('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice, sessionId }),
    }, 2, 250);

    if (!resp.ok || !resp.body) {
      const raw = await resp.text().catch(()=> '');
      console.error('[chat-stream] HTTP', resp.status, 'raw=', raw);
      throw new Error('chat_stream_failed');
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let finalText = '';
    clear(replyEl);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta?.content || j.delta || j.content || j.text || '';
          if (d) { finalText += d; append(replyEl, d); }
        } catch {
          finalText += data; append(replyEl, data);
        }
      }
    }
    return finalText.trim();
  }

  // ---------- Send ----------
  async function handleSend() {
    try {
      unlockAudioOnce();
      const text = inputEl?.value?.trim();
      if (!text) return;
      setStatus('thinking');
      stopSpeaking();
      const reply = await chatStream(text, getVoice());
      setStatus('speaking');
      await speakText(reply, getVoice());
      setStatus('idle');
    } catch (e) {
      console.error('[SEND] error', e);
      setStatus('idle');
    }
  }

  // ---------- PTT / STT (Universal) ----------
  const TIMESLICE_MS     = 450;
  const RELEASE_TAIL_MS  = 420;
  const SILENCE_DB       = -48;
  const MAX_TAIL_MS      = 1200;
  const MIN_SPEECH_MS    = 600;  // NEW: avoid tiny “breaths”
  const SMALL_BLOB_MIN   = 2000;
  const PCM_SAMPLE_RATE  = 16000;

  let mediaStream = null, mediaRecorder = null, chunks = [];
  let analyser = null, sourceNode = null;
  let startTimeMs = 0;

  const hasMediaRecorder = () => typeof window.MediaRecorder !== 'undefined';
  const isSafari = () => /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  function mimePick() {
    if (MediaRecorder.isTypeSupported?.('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported?.('audio/ogg')) return 'audio/ogg';
    return 'audio/webm';
  }
  function toB64(buf) {
    let bin = '', bytes = new Uint8Array(buf);
    for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function rmsDb(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = (samples[i] - 128) / 128.0;
      sum += v * v;
    }
    const mean = sum / samples.length;
    const rms = Math.sqrt(mean);
    return 20 * Math.log10(rms + 1e-6);
  }

  async function getUserMediaStream() {
    const base = { audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
    try { return await navigator.mediaDevices.getUserMedia(base); }
    catch {
      const alt = { audio: { channelCount: 1, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: true } };
      return await navigator.mediaDevices.getUserMedia(alt);
    }
  }

  // WAV fallback
  let waScriptNode = null;
  let waBuffers = [];
  let waInputSampleRate = 48000;

  function encodeWavFromFloat32(buffers, inputRate, targetRate = PCM_SAMPLE_RATE) {
    let length = buffers.reduce((s, b) => s + b.length, 0);
    let merged = new Float32Array(length);
    let off = 0; for (const b of buffers) { merged.set(b, off); off += b.length; }

    const ratio = inputRate / targetRate;
    const newLen = Math.floor(merged.length / ratio);
    const down = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const s = i * ratio;
      const s0 = Math.floor(s);
      const s1 = Math.min(s0 + 1, merged.length - 1);
      const frac = s - s0;
      down[i] = merged[s0] * (1 - frac) + merged[s1] * frac;
    }

    const dv = new DataView(new ArrayBuffer(44 + newLen * 2));
    let p = 0;
    const WS = (s) => { for (let i=0;i<s.length;i++) dv.setUint8(p++, s.charCodeAt(i)); };
    const U32 = (v) => { dv.setUint32(p, v, true); p += 4; };
    const U16 = (v) => { dv.setUint16(p, v, true); p += 2; };

    WS('RIFF'); U32(36 + newLen * 2); WS('WAVE'); WS('fmt '); U32(16); U16(1); U16(1);
    U32(targetRate); U32(targetRate * 2); U16(2); U16(16); WS('data'); U32(newLen * 2);

    for (let i = 0; i < newLen; i++) {
      let s = Math.max(-1, Math.min(1, down[i]));
      dv.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true); p += 2;
    }

    return new Blob([dv.buffer], { type: 'audio/wav' });
  }

  async function startFallbackRecorder() {
    if (!ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ac = new Ctx({ latencyHint: 'interactive' });
    }
    if (ac?.state === 'suspended') await ac.resume();

    sourceNode = ac.createMediaStreamSource(mediaStream);
    analyser = ac.createAnalyser(); analyser.fftSize = 1024; sourceNode.connect(analyser);

    const bufferSize = 2048;
    waScriptNode = ac.createScriptProcessor(bufferSize, 1, 1);
    waBuffers = [];
    waInputSampleRate = ac.sampleRate || 48000;

    sourceNode.connect(waScriptNode);
    waScriptNode.connect(ac.destination);
    waScriptNode.onaudioprocess = (e) => {
      const ch0 = e.inputBuffer.getChannelData(0);
      waBuffers.push(new Float32Array(ch0));
    };
  }
  function stopFallbackRecorder() {
    try { waScriptNode && (waScriptNode.disconnect(), waScriptNode.onaudioprocess = null); } catch {}
  }

  async function startPTT() {
    try {
      unlockAudioOnce();
      stopSpeaking();
      setStatus('listening');
      chunks = [];
      startTimeMs = performance.now();

      mediaStream = await getUserMediaStream();

      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!ac && Ctx) ac = new Ctx({ latencyHint: 'interactive' });
      if (ac?.state === 'suspended') await ac.resume();

      sourceNode = ac?.createMediaStreamSource ? ac.createMediaStreamSource(mediaStream) : null;
      analyser = ac?.createAnalyser ? ac.createAnalyser() : null;
      if (sourceNode && analyser) { analyser.fftSize = 1024; sourceNode.connect(analyser); }

      if (hasMediaRecorder() && !(isSafari() && MediaRecorder && MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported('audio/webm'))) {
        const mime = mimePick();
        mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });
        mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mediaRecorder.onstop = onPTTStop;
        mediaRecorder.start(TIMESLICE_MS);
      } else {
        await startFallbackRecorder();
      }
    } catch (e) {
      console.error('[PTT] start error', e);
      setStatus('idle');
    }
  }

  async function waitTail() {
    const buf = new Uint8Array(256);
    const tailStart = performance.now();
    const minTailAt = tailStart + RELEASE_TAIL_MS;

    while (true) {
      if (!analyser) break;
      analyser.getByteTimeDomainData(buf);
      const db = rmsDb(buf);
      const now = performance.now();
      const passedMinTail = now >= minTailAt;
      const exceededMax = now - tailStart >= MAX_TAIL_MS;
      if (passedMinTail && (db < SILENCE_DB || exceededMax)) break;
      await sleep(45);
    }
  }

  async function stopPTT() {
    try {
      await waitTail();

      // Guard: require minimum speech duration
      if (startTimeMs && performance.now() - startTimeMs < MIN_SPEECH_MS) {
        cleanupAudio();
        setStatus('idle');
        transcriptEl && (transcriptEl.textContent = '(no speech)');
        return;
      }

      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.requestData?.(); } catch {}
        mediaRecorder.stop();
      } else {
        const wavBlob = encodeWavFromFloat32(waBuffers, waInputSampleRate, PCM_SAMPLE_RATE);
        await processTranscriptFromBlob(wavBlob);
        cleanupAudio();
      }
    } catch (e) {
      console.warn('[PTT] stop error', e);
      cleanupAudio();
    }
  }

  function cleanupAudio() {
    try {
      mediaStream?.getTracks().forEach(t => t.stop());
      sourceNode && sourceNode.disconnect && sourceNode.disconnect();
      analyser && analyser.disconnect && analyser.disconnect();
      stopFallbackRecorder();
    } catch {}
    chunks = []; mediaRecorder = null; mediaStream = null; analyser = null; sourceNode = null;
  }

  async function onPTTStop() {
    try {
      await sleep(10);
      if (!chunks.length) {
        transcriptEl && (transcriptEl.textContent = '(no audio captured)');
        setStatus('idle'); return cleanupAudio();
      }
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
      await processTranscriptFromBlob(blob);
    } catch (e) {
      console.error('[PTT] flow error', e);
      setStatus('idle');
    } finally {
      cleanupAudio();
    }
  }

  async function processTranscriptFromBlob(blob) {
    setStatus('transcribing');

    if (blob.size < SMALL_BLOB_MIN) {
      transcriptEl && (transcriptEl.textContent = '(no speech)');
      setStatus('idle'); return;
    }

    const ab    = await blob.arrayBuffer();
    const mime  = blob.type || 'audio/wav';
    const b64   = toB64(ab);
    const dataUrl = `data:${mime};base64,${b64}`;
    const fileExt = mimeToExt(mime);

    // STT with retry — include mime + fileExt
    let sttJson = {};
    let ok = false, lastStatus = 0;

    for (let i=0;i<2;i++) {
      let resp;
      try {
        resp = await fetch('/.netlify/functions/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: dataUrl, mime, fileExt, language: 'en' }),
        });
        lastStatus = resp.status;
        if (resp.ok) { sttJson = await resp.json(); ok = true; break; }
      } catch {}
      // break quickly on 4xx to avoid loops
      if (lastStatus >= 400 && lastStatus < 500) break;
      await sleep(250 * (i+1));
    }

    if (!ok) {
      transcriptEl && (transcriptEl.textContent = '(stt failed)');
      setStatus('idle'); return;
    }

    const transcript = (sttJson?.transcript || '').trim();
    transcriptEl && (transcriptEl.textContent = transcript || '(no speech)');
    if (!transcript) { setStatus('idle'); return; }

    // Chat
    setStatus('thinking');
    let reply = '';
    let chatStatus = 0;
    try {
      const r = await fetch('/api/chat-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: transcript, voice: getVoice(), sessionId }),
      });
      chatStatus = r.status;
      if (!r.ok || !r.body) throw new Error('chat_stream_failed');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      clear(replyEl);
      let final = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const d = j.choices?.[0]?.delta?.content || j.delta || j.content || j.text || '';
            if (d) { final += d; append(replyEl, d); }
          } catch { final += data; append(replyEl, data); }
        }
      }
      reply = final.trim();
    } catch (e) {
      console.error('[chat] error', e);
      // handled by auto-loop guard below
    }

    if (!reply) {
      setStatus('idle'); return;
    }

    setStatus('speaking');
    await speakText(reply, getVoice());
    setStatus('idle');
  }

  // ---------- Continuous Mode (with anti-loop) ----------
  let autoMode = false;
  let loopInFlight = false;
  let consecutiveClientErrors = 0;
  const MAX_CLIENT_ERR = 3;

  async function autoLoop() {
    if (loopInFlight || !autoMode) return;
    loopInFlight = true;
    try {
      await startPTT();
      await waitTail();
      await stopPTT();
      // If we reached here without setting transcript or reply, still okay.
      consecutiveClientErrors = 0; // reset on any successful cycle
    } catch (e) {
      console.warn('[autoLoop]', e);
      consecutiveClientErrors++;
    } finally {
      loopInFlight = false;
      if (autoMode) {
        if (consecutiveClientErrors >= MAX_CLIENT_ERR) {
          autoMode = false;
          loopBtn && (loopBtn.textContent = 'Start chat');
          setStatus('idle');
          console.warn('[autoLoop] stopped after repeated client errors');
          return;
        }
        setTimeout(autoLoop, 120); // short idle to avoid hot spin
      }
    }
  }

  // ---------- Wire UI ----------
  sendBtn?.addEventListener('click', handleSend);

  speakBtn?.addEventListener('click', async () => {
    stopSpeaking();
    const text = replyEl?.textContent?.trim() || inputEl?.value?.trim();
    if (!text) return;
    setStatus('speaking'); await speakText(text, getVoice()); setStatus('idle');
  });

  if (pttBtn) {
    // PTT
    const down = (e) => { e.preventDefault?.(); startPTT(); };
    const up   = (e) => { e.preventDefault?.(); stopPTT();  };
    pttBtn.addEventListener('pointerdown', down);
    pttBtn.addEventListener('pointerup',   up);
    pttBtn.addEventListener('pointerleave', up);
    pttBtn.addEventListener('mousedown', down);
    pttBtn.addEventListener('mouseup',   up);
    pttBtn.addEventListener('touchstart', down, { passive: false });
    pttBtn.addEventListener('touchend',   up,   { passive: false });
  }

  if (loopBtn) {
    loopBtn.textContent = 'Start chat';
    loopBtn.addEventListener('click', () => {
      unlockAudioOnce();
      if (!autoMode) {
        autoMode = true;
        consecutiveClientErrors = 0;
        loopBtn.textContent = 'Stop chat';
        setStatus('listening');
        autoLoop();
      } else {
        autoMode = false;
        loopBtn.textContent = 'Start chat';
        setStatus('idle');
        cleanupAudio();
      }
    });
  }

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      try { stopSpeaking(); } catch {}
      autoMode = false;
      loopBtn && (loopBtn.textContent = 'Start chat');
      cleanupAudio();
      setStatus('idle');
    }
  });

  setStatus('idle');
  console.log('[Keilani] chat.js ready (Universal + anti-loop + session)', { sessionId });
})();
