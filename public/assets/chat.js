/* public/assets/chat.js
   Keilani Brain — Live
   Edge streaming + voices + PTT + barge-in + session memory
   iOS PTT (audio/mp4), VAD with hysteresis, tunable via URL (?silence=, ?vad=, ?vadLow=)
   Optional Start Chat (continuous) button with auto-chunking
*/

(() => {
  const $ = (s) => document.querySelector(s);
  const inputEl      = $('#textIn')    || $('#input')  || $('textarea');
  const sendBtn      = $('#sendBtn')   || $('#send');
  const speakBtn     = $('#speakBtn')  || $('#speak');
  const pttBtn       = $('#pttBtn')    || $('#ptt') || $('#holdToTalk');
  const voiceSel     = $('#voicePick') || $('#voice') || $('#voiceSelect');
  const statusPill   = $('#statePill') || $('#status') || $('.status');
  const transcriptEl = $('#transcriptBox') || $('#transcript');
  const replyEl      = $('#reply');

  // Add Start Chat if missing
  let startBtn = $('#startBtn') || document.getElementById('startChatBtn');
  if (!startBtn) {
    startBtn = document.createElement('button');
    startBtn.id = 'startBtn';
    startBtn.textContent = 'Start Chat';
    startBtn.style.marginLeft = '8px';
    const row = document.querySelector('.row') || document.body;
    row.appendChild(startBtn);
  }

  // ---------- URL + IDs ----------
  const qp = new URLSearchParams(location.search);
  const urlUser    = qp.get('user') || '';
  const urlSession = qp.get('session') || '';
  const urlVoice   = qp.get('voice') || '';
  const doReset    = qp.has('reset');
  // VAD knobs
  const urlSilence = Number(qp.get('silence')) || NaN;
  const urlVadHi   = Number(qp.get('vad'))     || NaN;
  const urlVadLo   = Number(qp.get('vadLow'))  || NaN;

  function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4))).toString(16)
    );
  }
  const SESSION_KEY = 'kb_session';
  const USER_KEY    = 'kb_user';
  if (doReset) { try { localStorage.removeItem(SESSION_KEY); } catch {}; try { localStorage.removeItem(USER_KEY); } catch {}; }
  function getId(key, prefix, override) {
    if (override) { localStorage.setItem(key, override); return override; }
    let v = localStorage.getItem(key);
    if (!v) { v = `${prefix}-${uuidv4()}`; localStorage.setItem(key, v); }
    return v;
  }
  const userId    = getId(USER_KEY, 'user', urlUser);
  const sessionId = getId(SESSION_KEY, 'sess', urlSession);

  // ---------- Audio / TTS ----------
  const player = (() => {
    let el = $('#ttsPlayer') || document.createElement('audio');
    el.id = 'ttsPlayer';
    el.preload = 'none';
    el.controls = true;
    el.playsInline = true;
    if (!el.parentNode) document.body.appendChild(el);
    return el;
  })();

  let bargeIn = { speaking: false };
  function unlockAudioOnce() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ac = Ctx ? new Ctx() : null;
      if (ac?.state === 'suspended') ac.resume();
      player.muted = false;
    } catch {}
  }
  document.addEventListener('touchstart', unlockAudioOnce, { once: true, passive: true });
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

  // ---------- Chat (Edge SSE) ----------
  async function chatStream(message, voice) {
    const resp = await fetch('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice, sessionId, userId }),
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
          const d = j.choices?.[0]?.delta?.content || j.delta || j.content || '';
          if (d) { finalText += d; append(replyEl, d); }
        } catch {
          finalText += data; append(replyEl, data);
        }
      }
    }
    return finalText.trim();
  }

  // ---------- Send (text) ----------
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

  // ---------- PTT / STT ----------
  function isiOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function isFirefox() { return /firefox/i.test(navigator.userAgent); }
  function mimePick() {
    if (isiOS() && MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
    if (isFirefox() && MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    return 'audio/mp4';
  }
  function toB64(buf) {
    let bin = '', bytes = new Uint8Array(buf);
    for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  let mediaStream = null, mediaRecorder = null, chunks = [];
  async function startPTT() {
    try {
      unlockAudioOnce();
      stopSpeaking();
      setStatus('listening');
      chunks = [];
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 }
      });
      const mime = mimePick();
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });
      mediaRecorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      mediaRecorder.onstop = onPTTStop;
      mediaRecorder.start(250);
      console.log('[PTT] recording… mime=', mime);
    } catch (e) {
      console.error('[PTT] start error', e);
      setStatus('idle');
    }
  }
  async function stopPTT() {
    try {
      if (mediaRecorder?.state === 'recording') { mediaRecorder.requestData?.(); mediaRecorder.stop(); }
      mediaStream?.getTracks().forEach(t => t.stop());
    } catch {}
  }
  async function onPTTStop() {
    try {
      setStatus('transcribing');
      if (!chunks.length) { setStatus('idle'); return; }
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || mimePick() });
      if (blob.size < 2000) { transcriptEl && (transcriptEl.textContent = '(no speech)'); setStatus('idle'); return; }
      const ab = await blob.arrayBuffer();
      const dataUrl = `data:${blob.type || 'audio/webm'};base64,${toB64(ab)}`;

      const stt = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl, language: 'en' }),
      });
      const sttJson = await stt.json().catch(()=> ({}));
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
      chunks = []; mediaRecorder = null; mediaStream = null;
    }
  }

  // Pointer + touch bindings (iOS safe)
  if (pttBtn) {
    const down = (e) => { e.preventDefault?.(); startPTT(); };
    const up   = (e) => { e.preventDefault?.(); stopPTT(); };
    pttBtn.addEventListener('pointerdown', down);
    pttBtn.addEventListener('pointerup', up);
    pttBtn.addEventListener('pointerleave', up);
    pttBtn.addEventListener('touchstart', down, { passive: false });
    pttBtn.addEventListener('touchend', up);
    pttBtn.addEventListener('touchcancel', up);
    pttBtn.addEventListener('mousedown', down);
    pttBtn.addEventListener('mouseup', up);
    pttBtn.addEventListener('mouseleave', up);
  }

  // ---------- Continuous Start Chat (VAD with hysteresis) ----------
  let liveOn = false;
  let vadTimer = null;
  let liveStream = null;
  let liveRecorder = null;
  let liveChunks = [];
  let speechActive = false;

  const DEFAULT_SILENCE_MS = !Number.isNaN(urlSilence) ? urlSilence : 1200; // was 700
  const VAD_HI = !Number.isNaN(urlVadHi) ? urlVadHi : 0.035;               // start talking threshold
  const VAD_LO = !Number.isNaN(urlVadLo) ? urlVadLo : 0.020;               // stop talking threshold
  const MIN_UTT_MS = 400; // ignore super-short blips

  async function liveToggle() { if (liveOn) await liveStop(); else await liveStart(); }

  async function liveStart() {
    unlockAudioOnce();
    stopSpeaking();
    setStatus('listening');
    liveChunks = [];
    liveOn = true;
    startBtn.textContent = 'Stop Chat';

    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 }
    });

    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const src = ac.createMediaStreamSource(liveStream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);

    const mime = mimePick();
    liveRecorder = new MediaRecorder(liveStream, { mimeType: mime, audioBitsPerSecond: 128000 });
    liveRecorder.ondataavailable = (e) => { if (e.data?.size) liveChunks.push(e.data); };

    let lastSpeech = 0;
    let startedAt = 0;

    function energy() {
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i=0;i<buf.length;i++){
        const v = (buf[i]-128)/128;
        sum += v*v;
      }
      return Math.sqrt(sum / buf.length);
    }

    function tick() {
      if (!liveOn) return;
      const rms = energy();
      const now = performance.now();

      if (!speechActive) {
        if (rms > VAD_HI) {
          speechActive = true;
          startedAt = now;
          try { liveRecorder.start(250); } catch {}
          lastSpeech = now;
        }
      } else {
        if (rms > VAD_LO) {
          lastSpeech = now;
        } else if (now - lastSpeech > DEFAULT_SILENCE_MS) {
          // end utterance
          speechActive = false;
          try { liveRecorder.requestData?.(); liveRecorder.stop(); } catch {}
          const dur = now - startedAt;
          if (dur > MIN_UTT_MS) handleLiveUtterance().catch(console.error);
          else liveChunks = [];
        }
      }

      vadTimer = setTimeout(tick, 60);
    }
    tick();
  }

  async function handleLiveUtterance() {
    try {
      setStatus('transcribing');
      if (!liveChunks.length) return;
      const blob = new Blob(liveChunks, { type: liveRecorder?.mimeType || mimePick() });
      liveChunks = [];
      if (blob.size < 1800) { setStatus('listening'); return; }
      const ab = await blob.arrayBuffer();
      const dataUrl = `data:${blob.type || 'audio/webm'};base64,${toB64(ab)}`;

      const stt = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl, language: 'en' }),
      });
      const sttJson = await stt.json().catch(()=> ({}));
      console.log('[LIVE] STT', stt.status, sttJson);
      const transcript = (sttJson?.transcript || '').trim();
      if (transcriptEl) transcriptEl.textContent = transcript || '(no speech)';
      if (!stt.ok || !transcript) { setStatus('listening'); return; }

      setStatus('thinking');
      const reply = await chatStream(transcript, getVoice());
      setStatus('speaking');
      await speakText(reply, getVoice());
      if (liveOn) setStatus('listening');
    } catch (e) {
      console.error('[LIVE] error', e);
      if (liveOn) setStatus('listening');
    }
  }

  async function liveStop() {
    liveOn = false;
    startBtn.textContent = 'Start Chat';
    if (vadTimer) { clearTimeout(vadTimer); vadTimer = null; }
    try {
      if (liveRecorder && liveRecorder.state === 'recording') {
        liveRecorder.requestData?.();
        liveRecorder.stop();
      }
    } catch {}
    try { liveStream?.getTracks().forEach(t => t.stop()); } catch {}
    liveRecorder = null; liveStream = null; liveChunks = [];
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
  startBtn?.addEventListener('click', () => { liveToggle(); });

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  if (urlVoice && voiceSel) voiceSel.value = urlVoice;
  setStatus('idle');
  console.log('[Keilani] chat.js ready', {
    userId, sessionId,
    silenceMs: DEFAULT_SILENCE_MS, vadHi: VAD_HI, vadLo: VAD_LO
  });
})();
