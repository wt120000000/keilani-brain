/* public/assets/chat.js
   Keilani Brain — Live
   Edge streaming + voices + PTT + barge-in + session memory
   Now with: release tail, soft VAD tail, flush guarantee, bigger timeslice
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

  let ac, bargeIn = { speaking: false };
  function unlockAudioOnce() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!ac && Ctx) ac = new Ctx();
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
    console.log('[TTS] stopSpeaking() – barge in');
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
    try { bargeIn.speaking = true; await player.play(); } catch (e) { console.warn('[TTS] autoplay?', e); }
  }

  // ---------- Chat Stream (Edge) ----------
  async function chatStream(message, voice) {
    const resp = await fetch('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice, sessionId }),
    });
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

  // ---------- PTT / STT  (end-clipping fixes) ----------
  let mediaStream = null, mediaRecorder = null, chunks = [];
  let analyser = null, sourceNode = null;   // for soft VAD tail
  let pttState = { holding: false, releasedAt: 0, stopping: false };

  // Tunables (feel free to tweak)
  const TIMESLICE_MS     = 400; // larger chunk -> better encoder flush
  const RELEASE_TAIL_MS  = 380; // minimum tail after button-up
  const SILENCE_DB       = -50; // roughly quiet threshold
  const SILENCE_HOLD_MS  = 450; // require this much silence before stop
  const MAX_TAIL_MS      = 1200; // cap total tail waiting time
  const SMALL_BLOB_MIN   = 2000; // bytes

  function mimePick() {
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    return 'audio/webm';
  }
  function toB64(buf) {
    let bin = '', bytes = new Uint8Array(buf);
    for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function rmsDb(samples) {
    // simple VAD-ish RMS->dB
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] / 128 - 1; // center on 0
      sum += v * v;
    }
    const mean = sum / samples.length;
    const rms = Math.sqrt(mean);
    const db = 20 * Math.log10(rms + 1e-6);
    return db;
  }

  async function startPTT() {
    try {
      unlockAudioOnce();
      stopSpeaking();
      setStatus('listening');
      pttState = { holding: true, releasedAt: 0, stopping: false };
      chunks = [];

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        }
      });

      // Wire analyser for soft VAD tail
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!ac && Ctx) ac = new Ctx();
      if (ac?.state === 'suspended') await ac.resume();
      sourceNode = ac?.createMediaStreamSource ? ac.createMediaStreamSource(mediaStream) : null;
      analyser = ac?.createAnalyser ? ac.createAnalyser() : null;
      if (sourceNode && analyser) {
        analyser.fftSize = 1024;
        sourceNode.connect(analyser);
      }

      const mime = mimePick();
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = onPTTStop;

      mediaRecorder.start(TIMESLICE_MS);
      console.log('[PTT] recording… mime=', mime);
    } catch (e) {
      console.error('[PTT] start error', e);
      setStatus('idle');
    }
  }

  // Wait for either enough silence OR max tail time after pointer-up
  async function waitTail() {
    const buf = new Uint8Array(256);
    const tailStart = performance.now();
    const minTailAt = tailStart + RELEASE_TAIL_MS;

    while (true) {
      if (!analyser) break; // nothing to sample
      analyser.getByteTimeDomainData(buf);
      const db = rmsDb(buf);

      const now = performance.now();
      const passedMinTail = now >= minTailAt;
      const exceededMax = now - tailStart >= MAX_TAIL_MS;

      if (passedMinTail && (db < SILENCE_DB || exceededMax)) break;

      // Small sleep to avoid a hot loop
      await new Promise(r => setTimeout(r, 45));
    }
  }

  async function stopPTT() {
    try {
      if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
      pttState.holding = false;
      pttState.releasedAt = performance.now();

      // Soft VAD + minimum tail
      await waitTail();

      if (pttState.stopping) return;
      pttState.stopping = true;

      // Guaranteed flush
      try { mediaRecorder.requestData?.(); } catch {}
      mediaRecorder.stop();
      // tracks stopped in onPTTStop finally{}
    } catch (e) {
      console.warn('[PTT] stop error', e);
    }
  }

  function onStopPromise(mr) {
    return new Promise((resolve) => {
      if (!mr) return resolve();
      const done = () => resolve();
      mr.addEventListener('stop', done, { once: true });
    });
  }

  async function onPTTStop() {
    try {
      // Ensure we actually got the last dataavailable emitted
      await new Promise(r => setTimeout(r, 10));

      setStatus('transcribing');

      if (!chunks.length) {
        console.warn('[PTT] no chunks captured');
        if (transcriptEl) transcriptEl.textContent = '(no audio captured)';
        setStatus('idle');
        return;
      }

      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || mimePick() });
      const sizeKB = Math.round(blob.size / 1024);
      console.log('[PTT] final blob', blob.type, sizeKB, 'KB');

      if (blob.size < SMALL_BLOB_MIN) {
        if (transcriptEl) transcriptEl.textContent = '(no speech)';
        console.log('[PTT] blob too small for STT (', blob.size, 'bytes )');
        setStatus('idle');
        return;
      }

      const ab = await blob.arrayBuffer();
      const dataUrl = `data:${blob.type || 'audio/webm'};base64,${toB64(ab)}`;

      const stt = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl, language: 'en' }),
      });

      let sttJson = {};
      try { sttJson = await stt.json(); } catch {}
      console.log('[PTT] STT', stt.status, sttJson);

      const transcript = (sttJson?.transcript || '').trim();
      if (transcriptEl) transcriptEl.textContent = transcript || '(no speech)';
      if (!stt.ok || !transcript) { setStatus('idle'); return; }

      setStatus('thinking');
      const reply = await chatStream(transcript, getVoice());
      setStatus('speaking');
      await speakText(reply, getVoice());
      setStatus('idle');
    } catch (e) {
      console.error('[PTT] flow error', e);
      setStatus('idle');
    } finally {
      // Cleanup audio graph & tracks
      try {
        mediaStream?.getTracks().forEach(t => t.stop());
        sourceNode && sourceNode.disconnect();
        analyser && analyser.disconnect && analyser.disconnect();
      } catch {}
      chunks = []; mediaRecorder = null; mediaStream = null; analyser = null; sourceNode = null;
      pttState = { holding: false, releasedAt: 0, stopping: false };
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
    // pointer
    pttBtn.addEventListener('pointerdown', startPTT);
    pttBtn.addEventListener('pointerup', stopPTT);
    pttBtn.addEventListener('pointerleave', () => mediaRecorder?.state === 'recording' && stopPTT());
    // mouse/touch fallbacks (iOS)
    pttBtn.addEventListener('mousedown', startPTT);
    pttBtn.addEventListener('mouseup', stopPTT);
    pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startPTT(); }, { passive: false });
    pttBtn.addEventListener('touchend',   (e) => { e.preventDefault(); stopPTT();  }, { passive: false });
  }

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  setStatus('idle');
  console.log('[Keilani] chat.js ready (Edge streaming + voices + session)');
})();
