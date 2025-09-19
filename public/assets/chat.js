// CHAT.JS BUILD TAG → 2025-09-19T12:45-0700
// Hands-free loop: mic → STT → LLM (/functions/chat) → TTS → mic…
// Minimal dependencies: /.netlify/functions/stt, /tts, /chat

(() => {
  const API_ORIGIN = location.origin; // same origin (api.keilani.ai)

  // --- Endpoints ---
  const STT_URL  = `${API_ORIGIN}/.netlify/functions/stt`;
  const TTS_URL  = `${API_ORIGIN}/.netlify/functions/tts`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;        // <= non-streaming JSON reply
  // If you prefer pretty redirects in netlify.toml, add fallbacks:
  const CHAT_URL_FALLBACK = `${API_ORIGIN}/api/chat`;

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
  const STATE = {
    IDLE:      'idle',
    RECORDING: 'recording',
    THINKING:  'thinking',
    SPEAKING:  'speaking',
  };
  let convoState = STATE.IDLE;
  let handsFree = false; // toggled by Start/Stop buttons

  // ===== Recorder state =====
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoStopTimer = null;
  const AUTO_STOP_MS = 6000; // chunk window; can raise to 8–10s later

  // ===== Identity (optional) =====
  const urlUid = new URLSearchParams(location.search).get('uid');
  const LS_KEY = 'keilani_user_id';
  let user_id = (urlUid && urlUid.trim()) || localStorage.getItem(LS_KEY) || 'global';
  log('user_id ⇒', user_id);

  // ===== Helpers =====
  function setState(s) {
    if (convoState !== s) {
      log(`state: ${convoState} → ${s}`);
      convoState = s;
    }
  }

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
    return data; // { transcript, meta }
  }

  // Await until playback ENDS (not just starts)
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

    // Promise resolves when audio ENDS
    await new Promise((resolve, reject) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      audio.play().catch(reject);
    });

    log('TTS played', blob.size, 'bytes');
  }

  async function askLLM(message) {
    // Try direct function, then pretty route fallback
    let res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id,
        messages: [
          { role: 'system', content: 'You are Keilani. Be kind, concise, and practical.' },
          { role: 'user', content: message }
        ]
      })
    });
    if (res.status === 404) {
      res = await fetch(CHAT_URL_FALLBACK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id,
          messages: [
            { role: 'system', content: 'You are Keilani. Be kind, concise, and practical.' },
            { role: 'user', content: message }
          ]
        })
      });
    }

    const data = await res.json().catch(() => ({}));
    log('CHAT status', res.status, data);

    if (!res.ok) throw new Error(data?.error || `chat ${res.status}`);
    // Accept a few common response shapes
    const text =
      data?.reply ||
      data?.message ||
      data?.choices?.[0]?.message?.content ||
      data?.text ||
      '';
    return (text || '').trim();
  }

  function clearAutoStop() {
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
  }

  function stopTracks() {
    try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    mediaStream = null;
  }

  // ===== Main loop pieces =====
  async function startRecording() {
    if (!handsFree) handsFree = true;
    if (convoState !== STATE.IDLE) {
      // Already mid-loop; ignore extra clicks.
      log('loop already running; state =', convoState);
      return;
    }
    loopOnce(); // kick the loop
  }

  async function loopOnce() {
    if (!handsFree) { setState(STATE.IDLE); return; }
    setState(STATE.RECORDING);

    // 1) Capture a short utterance
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/ogg;codecs=opus';

      chunks = [];
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferredMime });

      const finished = new Promise((resolve) => {
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size) {
            chunks.push(e.data);
            log('chunk', e.data.type, e.data.size, 'bytes');
          }
        };
        mediaRecorder.onerror = (e) => {
          console.error('[CHAT] recorder error', e);
          log('recorder error', String(e?.error || e?.name || e));
          resolve(null);
        };
        mediaRecorder.onstop = async () => {
          clearAutoStop();
          const blob = new Blob(chunks, { type: preferredMime });
          log('final blob', blob.type, blob.size, 'bytes');
          stopTracks();
          resolve(blob);
        };
      });

      mediaRecorder.start();
      log('recording started with', preferredMime);

      // Auto-stop window; you can later replace with VAD if you want.
      clearAutoStop();
      autoStopTimer = setTimeout(() => {
        try {
          if (mediaRecorder && mediaRecorder.state === 'recording') {
            log('auto-stop timer fired');
            mediaRecorder.stop();
            log('recording stopped (auto)');
          }
        } catch {}
      }, AUTO_STOP_MS);

      const blob = await finished;
      mediaRecorder = null;
      chunks = [];

      if (!blob || blob.size < 4096) {
        log('silence or too-short; retrying…');
        // small pause to avoid a tight loop
        await new Promise(r => setTimeout(r, 300));
        setState(STATE.IDLE);
        return loopOnce();
      }

      // 2) STT
      setState(STATE.THINKING);
      const stt = await sttUploadBlob(blob);
      const transcript = (stt?.transcript || '').trim();
      log('TRANSCRIPT:', transcript || '<empty>');

      // If user said nothing useful, restart
      if (!transcript) {
        setState(STATE.IDLE);
        return loopOnce();
      }

      // 3) LLM reply
      const reply = await askLLM(transcript);
      const say = reply || "I'm not sure yet, could you rephrase?";
      log('REPLY:', say);

      // 4) TTS speak → when ends, re-loop
      setState(STATE.SPEAKING);
      await speak(say);

      // 5) Loop again if still hands-free
      setState(STATE.IDLE);
      if (handsFree) return loopOnce();

    } catch (err) {
      console.error(err);
      log('loop error', String(err && err.message || err));
      stopTracks();
      clearAutoStop();
      mediaRecorder = null;
      chunks = [];
      // brief backoff then continue if still on
      await new Promise(r => setTimeout(r, 500));
      setState(STATE.IDLE);
      if (handsFree) return loopOnce();
    }
  }

  function stopConversation() {
    handsFree = false;
    clearAutoStop();
    try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch {}
    stopTracks();
    mediaRecorder = null;
    chunks = [];
    setState(STATE.IDLE);
    log('hands-free loop stopped');
  }

  // ===== Wire UI =====
  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded; wiring handlers');
    const recBtn  = document.querySelector('#recordBtn');
    const stopBtn = document.querySelector('#stopBtn');
    const ttsBtn  = document.querySelector('#sayBtn');

    recBtn?.addEventListener('click', () => { log('start conversation click'); startRecording(); });
    stopBtn?.addEventListener('click', () => { log('stop conversation click'); stopConversation(); });

    // "Speak Test Line" still works as a sanity check for TTS
    ttsBtn?.addEventListener('click', () => { log('tts click'); speak('Hey—Keilani is in hands-free mode now.'); });
  });

  // expose for console testing
  window.startConversation = startRecording;
  window.stopConversation  = stopConversation;
})();
