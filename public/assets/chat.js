/* public/assets/chat.js
   Keilani Brain — Universal mic stack
   - Edge chat streaming + ElevenLabs TTS + PTT + barge-in + session memory
   - Cross-browser recorder:
       1) MediaRecorder (Opus OGG/WEBM) when stable
       2) Fallback: WebAudio PCM → WAV
   - End-clipping fixes: release tail + soft VAD tail + guaranteed flush
   - iOS/Safari quirks: autoplay unlock, touch events, visibility cleanup
   - Retries with exponential backoff for STT & chat stream
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

  // ---------- Session ----------
  const SESSION_KEY = 'kb_session';
  function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4))).toString(16)
    );
  }
  function getSessionId() {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) { id = uuidv4(); localStorage.setItem(SESSION_KEY, id); }
    return id;
  }
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

  function setStatus(s) { if (statusPill) statusPill.textContent = s; }
  function getVoice() { return voiceSel?.value || ""; }
  function clear(el) { if (el) el.textContent = ''; }
  function append(el, t) {
    if (!el || !t) return;
    const span = document.createElement('span');
    span.textContent = t;
    el.appendChild(span);
  }
  function stopSpeaking() {
    try { player.pause(); player.currentTime = 0; } catch {}
    bargeIn.speaking = false;
    // console.log('[TTS] stopSpeaking() – barge in');
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
    try { bargeIn.speaking = true; await player.play(); } catch (e) { /* autoplay blocked until gesture */ }
  }

  // ---------- Utilities ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function fetchWithRetry(url, opts, tries = 3, baseDelay = 300) {
    for (let i=0;i<tries;i++) {
      const resp = await fetch(url, opts).catch(() => null);
      if (resp && resp.ok) return resp;
      if (i < tries - 1) await sleep(baseDelay * Math.pow(2, i) + Math.random()*100);
    }
    throw new Error('fetch_failed');
  }

  // ---------- Chat Stream (Edge) ----------
  async function chatStream(message, voice) {
    const resp = await fetchWithRetry('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice, sessionId }),
    }, 3, 250);

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
  // Tunables
  const TIMESLICE_MS     = 400;  // MediaRecorder timeslice
  const RELEASE_TAIL_MS  = 380;  // min tail after button-up
  const SILENCE_DB       = -50;  // VAD threshold (lower = more sensitive)
  const SILENCE_HOLD_MS  = 450;  // silence duration to stop
  const MAX_TAIL_MS      = 1200; // cap tail
  const SMALL_BLOB_MIN   = 2000; // bytes
  const PCM_SAMPLE_RATE  = 16000;// fallback PCM sample rate (WAV)

  // State
  let mediaStream = null, mediaRecorder = null, chunks = [];
  let analyser = null, sourceNode = null;
  let pttState = { holding: false, stopping: false };

  function hasMediaRecorder() {
    return typeof window.MediaRecorder !== 'undefined';
  }
  function isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  }
  function mimePick() {
    // Prefer OGG on Firefox; WEBM elsewhere; both tested on modern Safari
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
    // simple amplitude-based VAD using uint8 time-domain samples
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = (samples[i] - 128) / 128.0;
      sum += v * v;
    }
    const mean = sum / samples.length;
    const rms = Math.sqrt(mean);
    const db = 20 * Math.log10(rms + 1e-6);
    return db;
  }

  async function getUserMediaStream() {
    const base = {
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        // Safari/iOS quirk: these DSPs sometimes eat the tail. Expose both variants:
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };
    try {
      return await navigator.mediaDevices.getUserMedia(base);
    } catch {
      // Fallback: disable EC/NS (helps in iOS in some environments)
      const alt = {
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true
        }
      };
      return await navigator.mediaDevices.getUserMedia(alt);
    }
  }

  // -------- Fallback recorder (WebAudio PCM -> WAV) --------
  // Collect Float32 in a ring; downsample to PCM16 WAV at 16k
  let waScriptNode = null;
  let waBuffers = []; // array of Float32Array chunks @ input sample rate
  let waInputSampleRate = 48000;

  function encodeWavFromFloat32(buffers, inputRate, targetRate = PCM_SAMPLE_RATE) {
    // Merge
    let length = buffers.reduce((sum, b) => sum + b.length, 0);
    let merged = new Float32Array(length);
    let off = 0;
    for (const b of buffers) { merged.set(b, off); off += b.length; }

    // Downsample (very simple linear interpolation)
    const ratio = inputRate / targetRate;
    const newLen = Math.floor(merged.length / ratio);
    const down = new Float32Array(newLen);
    let idx = 0;
    for (let i = 0; i < newLen; i++) {
      const s = i * ratio;
      const s0 = Math.floor(s);
      const s1 = Math.min(s0 + 1, merged.length - 1);
      const frac = s - s0;
      down[i] = merged[s0] * (1 - frac) + merged[s1] * frac;
    }

    // PCM16
    const pcm = new DataView(new ArrayBuffer(44 + newLen * 2));
    let p = 0;
    const writeStr = (s) => { for (let i=0;i<s.length;i++) pcm.setUint8(p++, s.charCodeAt(i)); };
    const writeU32 = (v) => { pcm.setUint32(p, v, true); p += 4; };
    const writeU16 = (v) => { pcm.setUint16(p, v, true); p += 2; };

    writeStr('RIFF');                 // RIFF header
    writeU32(36 + newLen * 2);        // file size - 8
    writeStr('WAVE');
    writeStr('fmt ');                 // fmt chunk
    writeU32(16);                     // PCM
    writeU16(1);                      // linear PCM
    writeU16(1);                      // channels = 1
    writeU32(targetRate);
    writeU32(targetRate * 2);         // byte rate (16-bit mono)
    writeU16(2);                      // block align
    writeU16(16);                     // bits per sample
    writeStr('data');
    writeU32(newLen * 2);

    // data
    for (let i = 0; i < newLen; i++) {
      let s = Math.max(-1, Math.min(1, down[i]));
      pcm.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      p += 2;
    }

    return new Blob([pcm.buffer], { type: 'audio/wav' });
  }

  async function startFallbackRecorder() {
    if (!ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ac = new Ctx({ latencyHint: 'interactive' });
    }
    if (ac?.state === 'suspended') await ac.resume();

    sourceNode = ac.createMediaStreamSource(mediaStream);
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    sourceNode.connect(analyser);

    // ScriptProcessor is deprecated but still best-supported fallback
    const bufferSize = 2048;
    waScriptNode = ac.createScriptProcessor(bufferSize, 1, 1);
    waBuffers = [];
    waInputSampleRate = ac.sampleRate || 48000;

    sourceNode.connect(waScriptNode);
    waScriptNode.connect(ac.destination); // required in some Safari versions to get callbacks

    waScriptNode.onaudioprocess = (e) => {
      const ch0 = e.inputBuffer.getChannelData(0);
      waBuffers.push(new Float32Array(ch0));
    };
  }

  function stopFallbackRecorder() {
    try {
      waScriptNode && (waScriptNode.disconnect(), waScriptNode.onaudioprocess = null);
    } catch {}
  }

  // -------- Common PTT flow --------
  async function startPTT() {
    try {
      unlockAudioOnce();
      stopSpeaking();
      setStatus('listening');
      pttState = { holding: true, stopping: false };
      chunks = [];

      mediaStream = await getUserMediaStream();

      // Wire analyser for soft VAD tail
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!ac && Ctx) ac = new Ctx({ latencyHint: 'interactive' });
      if (ac?.state === 'suspended') await ac.resume();
      sourceNode = ac?.createMediaStreamSource ? ac.createMediaStreamSource(mediaStream) : null;
      analyser = ac?.createAnalyser ? ac.createAnalyser() : null;
      if (sourceNode && analyser) {
        analyser.fftSize = 1024;
        sourceNode.connect(analyser);
      }

      // Choose recorder path
      if (hasMediaRecorder() && !isSafariLegacyBug()) {
        const mime = mimePick();
        mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });
        mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mediaRecorder.onstop = onPTTStop;
        mediaRecorder.start(TIMESLICE_MS);
      } else {
        // Fallback PCM WAV
        await startFallbackRecorder();
      }
    } catch (e) {
      console.error('[PTT] start error', e);
      setStatus('idle');
    }
  }

  function isSafariLegacyBug() {
    // Some Safari 15/early 16 builds have MediaRecorder but produce broken Opus.
    // Heuristic: old Safari + MediaRecorder => prefer fallback WAV.
    const ua = navigator.userAgent || '';
    const safari = ua.match(/Version\/(\d+)\.(\d+)/i);
    const isSafariUA = /^((?!chrome|android).)*safari/i.test(ua);
    if (!isSafariUA || !safari) return false;
    const major = parseInt(safari[1], 10);
    return hasMediaRecorder() && major < 16; // guardrail
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
      if (!mediaStream) return;
      pttState.holding = false;

      // Soft VAD + minimum tail
      await waitTail();

      if (pttState.stopping) return;
      pttState.stopping = true;

      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.requestData?.(); } catch {}
        mediaRecorder.stop();
        // Blob built in onPTTStop()
      } else {
        // Fallback: build WAV now
        const wavBlob = encodeWavFromFloat32(waBuffers, waInputSampleRate, PCM_SAMPLE_RATE);
        await processTranscriptFromBlob(wavBlob);
        cleanupAudio();
      }
    } catch (e) {
      console.warn('[PTT] stop error', e);
      cleanupAudio();
    }
  }

  async function onPTTStop() {
    try {
      // ensure final dataavailable delivered
      await sleep(10);

      if (!chunks.length) {
        console.warn('[PTT] no chunks captured');
        if (transcriptEl) transcriptEl.textContent = '(no audio captured)';
        setStatus('idle');
        return cleanupAudio();
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

  function cleanupAudio() {
    try {
      mediaStream?.getTracks().forEach(t => t.stop());
      sourceNode && sourceNode.disconnect && sourceNode.disconnect();
      analyser && analyser.disconnect && analyser.disconnect();
      stopFallbackRecorder();
    } catch {}
    chunks = [];
    mediaRecorder = null;
    mediaStream = null;
    analyser = null;
    sourceNode = null;
    pttState = { holding: false, stopping: false };
  }

  async function processTranscriptFromBlob(blob) {
    setStatus('transcribing');

    if (blob.size < SMALL_BLOB_MIN) {
      if (transcriptEl) transcriptEl.textContent = '(no speech)';
      setStatus('idle');
      return;
    }

    const ab = await blob.arrayBuffer();
    const mime = blob.type || 'audio/wav';
    const dataUrl = `data:${mime};base64,${toB64(ab)}`;

    // STT with retry
    let sttJson = {};
    let ok = false;
    for (let i=0;i<3;i++) {
      const stt = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl, language: 'en' }),
      }).catch(() => null);

      if (stt && stt.ok) {
        try { sttJson = await stt.json(); } catch { sttJson = {}; }
        ok = true; break;
      }
      await sleep(200 * Math.pow(2, i));
    }

    if (!ok) {
      transcriptEl && (transcriptEl.textContent = '(stt failed)');
      setStatus('idle');
      return;
    }

    const transcript = (sttJson?.transcript || '').trim();
    if (transcriptEl) transcriptEl.textContent = transcript || '(no speech)';
    if (!transcript) { setStatus('idle'); return; }

    setStatus('thinking');
    // chat stream with retry
    let reply = '';
    for (let i=0;i<2;i++) {
      try {
        reply = await chatStream(transcript, getVoice());
        break;
      } catch {
        await sleep(300 * Math.pow(2, i));
      }
    }
    if (!reply) { setStatus('idle'); return; }

    setStatus('speaking');
    await speakText(reply, getVoice());
    setStatus('idle');
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
    // pointer
    pttBtn.addEventListener('pointerdown', startPTT);
    pttBtn.addEventListener('pointerup', stopPTT);
    pttBtn.addEventListener('pointerleave', () => mediaRecorder?.state === 'recording' && stopPTT());
    // mouse/touch (iOS/Safari)
    pttBtn.addEventListener('mousedown', startPTT);
    pttBtn.addEventListener('mouseup', stopPTT);
    pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startPTT(); }, { passive: false });
    pttBtn.addEventListener('touchend',   (e) => { e.preventDefault(); stopPTT();  }, { passive: false });
  }

  // Enter to send
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  // Page hide/blur: clean audio (mobile Safari backgrounding safety)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      try { stopSpeaking(); } catch {}
      try { cleanupAudio(); } catch {}
    }
  });

  setStatus('idle');
  console.log('[Keilani] chat.js ready (Universal mic stack + Edge streaming + voices + session)');
})();
