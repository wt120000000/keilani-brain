// CHAT.JS BUILD TAG → 2025-09-19T14:05-0700
// Hands-free loop: mic → STT → /functions/chat (messages array) → TTS → loop

(() => {
  const API_ORIGIN = location.origin;

  const STT_URL  = `${API_ORIGIN}/.netlify/functions/stt`;
  const TTS_URL  = `${API_ORIGIN}/.netlify/functions/tts`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;

  // ===== UI logger =====
  const logEl = document.getElementById('log');
  const log = (...args) => {
    console.log('[CHAT]', ...args);
    if (logEl) {
      const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
      logEl.textContent += (logEl.textContent ? '\n' : '') + line;
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  // ===== Conversation state =====
  const STATE = { IDLE:'idle', RECORDING:'recording', THINKING:'thinking', SPEAKING:'speaking' };
  let convoState = STATE.IDLE;
  let handsFree = false;

  // ===== Recorder state =====
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoStopTimer = null;
  const AUTO_STOP_MS = 6000;

  // ===== Identity =====
  const urlUid = new URLSearchParams(location.search).get('uid');
  const LS_KEY = 'keilani_user_id';
  let user_id = (urlUid && urlUid.trim()) || localStorage.getItem(LS_KEY) || 'global';
  log('user_id ⇒', user_id);

  // ===== Helpers =====
  function setState(s) { if (convoState !== s) { log(`state: ${convoState} → ${s}`); convoState = s; } }
  function clearAutoStop() { if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; } }
  function stopTracks() { try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {} mediaStream = null; }

  function blobToBase64Raw(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const s = reader.result || '';
        const comma = s.indexOf(',');
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function sttUploadBlob(blob) {
    const base64 = await blobToBase64Raw(blob);
    const simpleMime = (blob.type || '').split(';')[0] || 'application/octet-stream';
    const filename =
      simpleMime.includes('webm') ? 'audio.webm' :
      simpleMime.includes('ogg')  ? 'audio.ogg'  :
      simpleMime.includes('mpeg') || simpleMime.includes('mp3') ? 'audio.mp3' :
      simpleMime.includes('m4a') || simpleMime.includes('mp4') ? 'audio.m4a' :
      simpleMime.includes('wav')  ? 'audio.wav'  : 'audio.bin';

    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: base64, language: 'en', mime: simpleMime, filename })
    });

    let data = null;
    try { data = await res.json(); } catch {}
    log('STT status', res.status, data);

    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  async function speak(text, opts = {}) {
    const payload = {
      text: String(text || 'Hello, Keilani here.'),
      voice: opts.voice || 'alloy',
      speed: typeof opts.speed === 'number' ? opts.speed : 1.0,
      format: 'mp3'
    };

    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const buf = await res.arrayBuffer();
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.parse(new TextDecoder().decode(buf)); } catch {}
      log('TTS error', res.status, detail || new TextDecoder().decode(buf));
      throw new Error(`TTS ${res.status}`);
    }

    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    await new Promise((resolve, reject) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      audio.play().catch(reject);
    });

    log('TTS played', blob.size, 'bytes');
  }

  // -------- Chat glue (only messages array) --------
  async function askLLM(userMessage) {
    const payload = {
      user_id,
      messages: [
        { role: 'system', content: 'You are Keilani. Be kind, concise, and practical.' },
        { role: 'user', content: userMessage }
      ]
    };

    const r = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const j = await r.json().catch(() => ({}));
    log('CHAT status', r.status, j);

    if (!r.ok) throw new Error(j?.error || `chat ${r.status}`);

    const text =
      j?.reply ||
      j?.message ||
      j?.choices?.[0]?.message?.content ||
      j?.text || '';

    return (text || "I'm here and listening.").trim();
  }

  // ===== Main loop =====
  async function startConversation() {
    if (!handsFree) handsFree = true;
    if (convoState !== STATE.IDLE) { log('loop already running'); return; }
    loopOnce();
  }

  async function loopOnce() {
    if (!handsFree) { setState(STATE.IDLE); return; }
    setState(STATE.RECORDING);

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/ogg;codecs=opus';

      chunks = [];
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferredMime });

      const finished = new Promise((resolve) => {
        mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mediaRecorder.onstop = () => {
          clearAutoStop();
          const blob = new Blob(chunks, { type: preferredMime });
          log('final blob', blob.type, blob.size, 'bytes');
          stopTracks();
          resolve(blob);
        };
      });

      mediaRecorder.start();
      log('recording started with', preferredMime);

      clearAutoStop();
      autoStopTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); log('recording stopped (auto)'); }
      }, AUTO_STOP_MS);

      const blob = await finished;
      mediaRecorder = null;
      chunks = [];

      if (!blob || blob.size < 4096) { setState(STATE.IDLE); return loopOnce(); }

      // STT
      setState(STATE.THINKING);
      const stt = await sttUploadBlob(blob);
      const transcript = (stt?.transcript || '').trim();
      log('TRANSCRIPT:', transcript || '<empty>');
      if (!transcript) { setState(STATE.IDLE); return loopOnce(); }

      // Chat
      const reply = await askLLM(transcript);
      log('REPLY:', reply);

      // TTS
      setState(STATE.SPEAKING);
      await speak(reply);

      setState(STATE.IDLE);
      if (handsFree) return loopOnce();

    } catch (err) {
      console.error(err);
      log('loop error', String(err?.message || err));
      stopTracks(); clearAutoStop();
      mediaRecorder = null; chunks = [];
      setState(STATE.IDLE);
      if (handsFree) return loopOnce();
    }
  }

  function stopConversation() {
    handsFree = false; clearAutoStop();
    try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch {}
    stopTracks(); mediaRecorder = null; chunks = [];
    setState(STATE.IDLE); log('hands-free loop stopped');
  }

  // ===== Wire UI =====
  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded; wiring handlers');
    document.querySelector('#recordBtn')?.addEventListener('click', () => { log('start conversation click'); startConversation(); });
    document.querySelector('#stopBtn')?.addEventListener('click', () => { log('stop conversation click'); stopConversation(); });
    document.querySelector('#sayBtn')?.addEventListener('click', () => { log('tts click'); speak('Hey—Keilani is ready.'); });
  });

  window.startConversation = startConversation;
  window.stopConversation  = stopConversation;
})();
