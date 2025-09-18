/* public/assets/chat.js
   Keilani Brain — Turn-based voice chat (robust analyser guards + turn lock)
*/

(() => {
  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const inputEl      = $('#textIn')    || $('#input')  || $('textarea');
  const sendBtn      = $('#sendBtn')   || $('#send');
  const voiceSel     = $('#voicePick') || $('#voice') || $('#voiceSelect');
  const statusPill   = $('#statePill') || $('#status') || $('.status');
  const transcriptEl = $('#transcriptBox') || $('#transcript');
  const replyEl      = $('#reply');

  // Make sure there is a Start/Stop toggle
  let chatBtn = $('#chatToggleBtn');
  if (!chatBtn) {
    chatBtn = document.createElement('button');
    chatBtn.id = 'chatToggleBtn';
    chatBtn.textContent = 'Start chat';
    chatBtn.className = 'btn';
    (sendBtn?.parentElement || document.body).appendChild(chatBtn);
  }

  // ---------- IDs ----------
  const uuidv4 = () =>
    ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4))).toString(16)
    );

  const SESSION_KEY = 'kb_session';
  const USER_KEY    = 'kb_user_id';

  function getSessionId() {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) { id = uuidv4(); localStorage.setItem(SESSION_KEY, id); }
    return id;
  }
  function getUserId() {
    const urlUid = new URLSearchParams(location.search).get('uid');
    if (urlUid) { localStorage.setItem(USER_KEY, urlUid); return urlUid; }
    let uid = localStorage.getItem(USER_KEY);
    if (!uid) { uid = `web-${uuidv4()}`; localStorage.setItem(USER_KEY, uid); }
    return uid;
  }

  const sessionId = getSessionId();
  const userId    = getUserId();

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
  const getVoice  = () => voiceSel?.value || '';
  const clear     = (el) => { if (el) el.textContent = ''; };
  const append    = (el, t) => { if (!el || !t) return; const s=document.createElement('span'); s.textContent=t; el.appendChild(s); };
  function stopSpeaking() { try { player.pause(); player.currentTime = 0; } catch {} }

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
    await player.play().catch(() => {});
  }

  // ---------- Helpers ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function fetchWithRetry(url, opts, tries = 2, baseDelay = 250) {
    let last;
    for (let i=0;i<tries;i++) {
      try {
        const resp = await fetch(url, opts);
        if (resp.ok) return resp;
        last = resp;
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
  const toB64 = (buf) => {
    let bin = '', bytes = new Uint8Array(buf);
    for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  // ---------- Chat Stream ----------
  async function chatStream(message, voice) {
    const resp = await fetchWithRetry('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice, sessionId, userId }),
    }, 2, 250);

    if (!resp.ok || !resp.body) {
      const raw = await resp.text().catch(()=> '');
      console.error('[chat-stream] HTTP', resp.status, 'raw=', raw);
      throw new Error(`chat_stream_failed_${resp.status}`);
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
        } catch { finalText += data; append(replyEl, data); }
      }
    }
    return finalText.trim();
  }

  // ---------- Mic (robust) ----------
  const TIMESLICE_MS     = 450;
  const RELEASE_TAIL_MS  = 350;
  const SILENCE_DB       = -56;
  const MAX_TAIL_MS      = 1500;
  const MIN_SPEECH_MS    = 400;
  const PCM_SAMPLE_RATE  = 16000;

  let mediaStream = null, mediaRecorder = null, chunks = [];
  let analyser = null, sourceNode = null;
  let startTimeMs = 0;

  const hasMediaRecorder = () => typeof window.MediaRecorder !== 'undefined';
  const isSafari = () => /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  function mimePick() {
    if (MediaRecorder?.isTypeSupported?.('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder?.isTypeSupported?.('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder?.isTypeSupported?.('audio/ogg')) return 'audio/ogg';
    return 'audio/webm';
  }
  async function getUserMediaStream() {
    const base = { audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
    try { return await navigator.mediaDevices.getUserMedia(base); }
    catch {
      const alt = { audio: { channelCount: 1, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: true } };
      return await navigator.mediaDevices.getUserMedia(alt);
    }
  }

// chat.js (or your recorder module)
let mediaRecorder;
let chunks = [];

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/ogg;codecs=opus';

  mediaRecorder = new MediaRecorder(stream, { mimeType: preferredMime });
  chunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      chunks.push(e.data);
      console.log('[STT] chunk bytes=', e.data.size);
    }
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: preferredMime });
    console.log('[STT] final blob', blob.type, blob.size, 'bytes');

    if (blob.size < 8192) {
      console.warn('[STT] too small; record a bit longer.');
      return;
    }

    const base64 = await blobToBase64Raw(blob); // raw base64, no data: prefix
    const res = await fetch('https://api.keilani.ai/.netlify/functions/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: base64,                  // <-- matches server
        language: 'en',
        // Optional: hint; server doesn’t require it
        mime: blob.type,                      // e.g. "audio/webm;codecs=opus"
        filename: blob.type.includes('webm') ? 'audio.webm'
                : blob.type.includes('ogg')  ? 'audio.ogg'
                : 'audio.wav',
      }),
    });

    const json = await res.json().catch(() => ({}));
    console.log('[STT] response', res.status, json);
  };

  mediaRecorder.start(); // we only post once on stop()
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function blobToBase64Raw(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = reader.result || '';
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s); // strip "data:...;base64,"
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

  // WAV fallback
  let waScriptNode = null;
  let waBuffers = [];
  let waInputSampleRate = 48000;

  async function startFallbackRecorder() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!ac && Ctx) ac = new Ctx({ latencyHint: 'interactive' });
    if (ac?.state === 'suspended') await ac.resume();

    try {
      sourceNode = ac.createMediaStreamSource(mediaStream);
      analyser = ac.createAnalyser(); analyser.fftSize = 1024; sourceNode.connect(analyser);
    } catch { analyser = null; }

    const bufferSize = 2048;
    waScriptNode = ac.createScriptProcessor(bufferSize, 1, 1);
    waBuffers = [];
    waInputSampleRate = ac.sampleRate || 48000;

    sourceNode && sourceNode.connect(waScriptNode);
    waScriptNode.connect(ac.destination);
    waScriptNode.onaudioprocess = (e) => {
      const ch0 = e.inputBuffer.getChannelData(0);
      waBuffers.push(new Float32Array(ch0));
    };
  }
  function stopFallbackRecorder() {
    try { waScriptNode && (waScriptNode.disconnect(), waScriptNode.onaudioprocess = null); } catch {}
  }
  function encodeWavFromFloat32(buffers, inputRate, targetRate = PCM_SAMPLE_RATE) {
    let length = buffers.reduce((s, b) => s + b.length, 0);
    let merged = new Float32Array(length);
    let off = 0; for (const b of buffers) { merged.set(b, off); off += b.length; }

    const ratio = inputRate / targetRate;
    const newLen = Math.floor(merged.length / ratio);
    const down = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const s = i * ratio;
      const s0 = Math.floor(s), s1 = Math.min(s0 + 1, merged.length - 1);
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

  async function startMic() {
    unlockAudioOnce();
    setStatus('listening');
    chunks = [];
    startTimeMs = performance.now();
    mediaStream = await getUserMediaStream();

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!ac && Ctx) ac = new Ctx({ latencyHint: 'interactive' });
    if (ac?.state === 'suspended') await ac.resume();

    try {
      if (ac?.createMediaStreamSource && ac?.createAnalyser) {
        sourceNode = ac.createMediaStreamSource(mediaStream);
        analyser = ac.createAnalyser();
        analyser.fftSize = 1024;
        sourceNode.connect(analyser);
      } else {
        analyser = null;
      }
    } catch { analyser = null; }

    if (hasMediaRecorder() && !(isSafari() && MediaRecorder && MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported('audio/webm'))) {
      const mime = mimePick();
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.start(TIMESLICE_MS);
    } else {
      await startFallbackRecorder();
    }
  }

  async function waitTail() {
    // If we don't have an analyser (some browsers/permissions), just wait a fixed tail.
    if (!analyser) { await sleep(RELEASE_TAIL_MS); return; }

    const buf = new Uint8Array(256);
    const tailStart = performance.now();
    const minTailAt = tailStart + RELEASE_TAIL_MS;

    while (true) {
      let db = -100;
      try {
        analyser.getByteTimeDomainData(buf);
        // quick RMS → dB
        let sum=0; for (let i=0;i<buf.length;i++){ const v=(buf[i]-128)/128; sum+=v*v; }
        db = 20*Math.log10(Math.sqrt(sum/buf.length)+1e-6);
      } catch {
        // If AudioContext/audio graph got torn down, bail with a fixed tail
        await sleep(RELEASE_TAIL_MS);
        return;
      }
      const now = performance.now();
      if ((now >= minTailAt && db < SILENCE_DB) || (now - tailStart) >= MAX_TAIL_MS) break;
      await sleep(45);
    }
  }

  function cleanupMic() {
    try {
      mediaStream?.getTracks().forEach(t => t.stop());
      sourceNode && sourceNode.disconnect && sourceNode.disconnect();
      analyser && analyser.disconnect && analyser.disconnect();
      stopFallbackRecorder();
    } catch {}
    chunks = []; mediaRecorder = null; mediaStream = null; analyser = null; sourceNode = null;
  }

  async function captureAndTranscribe() {
    await waitTail();

    if (mediaRecorder && mediaRecorder.state === 'recording') {
      const stopped = new Promise((res) => { mediaRecorder.onstop = () => res(); });
      try { mediaRecorder.stop(); } catch {}
      await stopped;
    }

    if (startTimeMs && performance.now() - startTimeMs < MIN_SPEECH_MS) {
      cleanupMic();
      transcriptEl && (transcriptEl.textContent = '(no speech)');
      return '';
    }

    let blob;
    if (chunks.length) {
      blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
    } else {
      blob = encodeWavFromFloat32(waBuffers, waInputSampleRate, PCM_SAMPLE_RATE);
    }

    if (!blob || blob.size < 800) {
      console.warn('[STT] tiny blob, size=', blob?.size || 0);
      cleanupMic();
      transcriptEl && (transcriptEl.textContent = '(no speech)');
      return '';
    }

    setStatus('transcribing');
    const ab   = await blob.arrayBuffer();
    const b64  = toB64(ab);
    const mime = blob.type || 'audio/wav';
    const fileExt = mimeToExt(mime);
    console.log('[STT] mime=', mime, 'bytes=', ab.byteLength);

    let sttJson = {};
    let ok = false;
    for (let i=0;i<2;i++) {
      try {
        const r = await fetch('/.netlify/functions/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: `data:${mime};base64,${b64}`, mime, fileExt, language: 'en' }),
        });
        if (r.ok) { sttJson = await r.json(); ok = true; break; }
        if (r.status >= 400 && r.status < 500) break;
      } catch {}
      await sleep(300*(i+1));
    }

    cleanupMic();
    const transcript = ok ? (sttJson?.transcript || '').trim() : '';
    transcriptEl && (transcriptEl.textContent = transcript || '(stt failed)');
    return transcript;
  }

  // ---------- State machine ----------
  let running = false;
  let turnLock = false; // prevents re-entrancy

  async function nextTurn() {
    if (!running || turnLock) return;
    turnLock = true;
    try {
      // listen
      setStatus('listening');
      await startMic();
      const transcript = await captureAndTranscribe();
      if (!running) return void (turnLock = false);
      if (!transcript) { await sleep(140); return void (turnLock = false), nextTurn(); }

      // think
      setStatus('thinking');
      let reply = '';
      try {
        reply = await chatStream(transcript, getVoice());
      } catch (e) {
        console.error('[chat] error', e);
        running = false; setStatus('idle'); chatBtn.textContent = 'Start chat';
        return;
      }
      if (!running) return;

      // speak then loop
      const voice = getVoice();
      const useTTS = !!voice && voice !== 'default' && voice !== '(default / no TTS)';
      if (useTTS) {
        setStatus('speaking');
        stopSpeaking();
        const ended = new Promise(res => {
          const onend = () => { player.removeEventListener('ended', onend); res(); };
          player.addEventListener('ended', onend, { once: true });
        });
        await speakText(reply, voice);
        await ended;
        await sleep(150);
      } else {
        setStatus('idle');
        await sleep(140);
      }
    } finally {
      turnLock = false;
      if (running) nextTurn();
    }
  }

  // ---------- UI ----------
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

  sendBtn?.addEventListener('click', handleSend);
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  chatBtn.addEventListener('click', () => {
    unlockAudioOnce();
    if (!running) {
      running = true;
      chatBtn.textContent = 'Stop chat';
      nextTurn();
    } else {
      running = false;
      chatBtn.textContent = 'Start chat';
      setStatus('idle');
      stopSpeaking();
      // full cleanup
      try { mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      running = false;
      chatBtn.textContent = 'Start chat';
      setStatus('idle');
      stopSpeaking();
      try { mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
    }
  });

  setStatus('idle');
  console.log('[Keilani] chat.js ready (Turn-based voice + userId + session)', { sessionId, userId });
})();
