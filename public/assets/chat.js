// CHAT.JS BUILD TAG → 2025-09-19T16:20-0700 (VAD-based auto-stop)

(() => {
  const API_ORIGIN = location.origin; // same origin (api.keilani.ai)
  const STT_URL   = `${API_ORIGIN}/.netlify/functions/stt`;
  const TTS_URL   = `${API_ORIGIN}/.netlify/functions/tts`;
  const CHAT_URL  = `${API_ORIGIN}/.netlify/functions/chat`;

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

  // ===== State =====
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];

  // VAD state
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let vadRaf = null;
  let vadLastSpeech = 0;
  let vadStartedAt = 0;

  // VAD tuning (adjust if needed)
  const MIN_CAPTURE_MS = 1200; // don't stop before this (lets you start talking)
  const SILENCE_MS     = 900;  // stop after this long of silence
  const MAX_CAPTURE_MS = 8000; // hard cap
  const VAD_INTERVAL   = 80;   // ms between checks
  const VAD_THRESH     = 7;    // sensitivity ~ amplitude delta (0-127 baseline=128)

  const USER_ID = "global";
  let loopMode = true; // default to conversational loop

  // ===== Helpers =====
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

    const body = { audioBase64: base64, language: 'en', mime: simpleMime, filename };
    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
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

    return new Promise((resolve) => {
      audio.onended = () => {
        URL.revokeObjectURL(url);
        log('TTS finished');
        if (loopMode) {
          log('🔁 auto-restart mic');
          startRecording();
        }
        resolve();
      };
      audio.play();
      log('TTS played', blob.size, 'bytes');
    });
  }

  async function askLLM(transcript) {
    const payload = { user_id: USER_ID, message: transcript };
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let data = null;
    try { data = await res.json(); } catch {}
    log('CHAT status', res.status, data);

    if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);
    if (data.reply) await speak(data.reply);
  }

  function cleanupVAD() {
    if (vadRaf) {
      cancelAnimationFrame(vadRaf);
      vadRaf = null;
    }
    try { sourceNode?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}
    sourceNode = null;
    analyser = null;
    // keep audioCtx around; it can be reused
  }

  function stopTracks() {
    try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    mediaStream = null;
  }

  // ===== Recording with VAD =====
  async function startRecording() {
    // Ensure single session
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      log('already recording; ignoring start');
      return;
    }
    stopTracks();
    cleanupVAD();
    chunks = [];

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // MediaRecorder setup (container)
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/ogg;codecs=opus';
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferredMime });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          chunks.push(e.data);
          log('chunk', e.data.type, e.data.size, 'bytes');
        }
      };

      mediaRecorder.onerror = (e) => {
        console.error('[CHAT] recorder error', e);
        log('recorder error', String(e?.error || e?.name || e));
      };

      mediaRecorder.onstop = async () => {
        cleanupVAD();
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        log('final blob', blob.type, blob.size, 'bytes');
        stopTracks();

        if (blob.size < 6000) {
          log('too small; record a bit longer.');
          mediaRecorder = null;
          chunks = [];
          return;
        }

        try {
          const r = await sttUploadBlob(blob);
          log('TRANSCRIPT:', r.transcript);
          await askLLM(r.transcript);
        } catch (err) {
          console.error(err);
          log('STT/CHAT failed', String(err && err.message || err));
        } finally {
          mediaRecorder = null;
          chunks = [];
        }
      };

      // WebAudio VAD pipeline
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      vadStartedAt = performance.now();
      vadLastSpeech = vadStartedAt;

      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        // Compute simple amplitude deviation from 128 baseline
        let maxDev = 0;
        for (let i = 0; i < buf.length; i++) {
          const dev = Math.abs(buf[i] - 128);
          if (dev > maxDev) maxDev = dev;
        }
        const now = performance.now();
        const speaking = maxDev >= VAD_THRESH;

        if (speaking) vadLastSpeech = now;

        const elapsed = now - vadStartedAt;
        const silence = now - vadLastSpeech;

        // stop conditions: after min capture and either long silence or hard cap
        if (elapsed >= MIN_CAPTURE_MS && (silence >= SILENCE_MS || elapsed >= MAX_CAPTURE_MS)) {
          try {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
              log('recording stopped (VAD)');
            }
          } catch (e) {
            console.warn('stop err', e);
          }
          return;
        }
        // pace checks ~VAD_INTERVAL
        vadRaf = setTimeout(() => requestAnimationFrame(tick), VAD_INTERVAL);
      };

      mediaRecorder.start(); // single pass; VAD decides when to stop
      log('recording started with', mediaRecorder.mimeType, '(VAD)');
      requestAnimationFrame(tick);

    } catch (err) {
      console.error(err);
      log('mic error', String(err && err.message || err));
      cleanupVAD();
      stopTracks();
      mediaRecorder = null;
      chunks = [];
    }
  }

  function stopRecording() {
    loopMode = false;
    try {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        log('recording stopped (manual)');
      } else {
        log('stop clicked but no active recorder');
      }
    } catch {}
    cleanupVAD();
    stopTracks();
  }

  // ===== Wire UI =====
  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded; wiring handlers');
    const recBtn  = document.querySelector('#recordBtn');
    const stopBtn = document.querySelector('#stopBtn');
    const ttsBtn  = document.querySelector('#sayBtn');
    const convBtn = document.querySelector('#convBtn'); // optional

    recBtn?.addEventListener('click', () => {
      loopMode = true;
      log('record click → loopMode ON');
      startRecording();
    });

    stopBtn?.addEventListener('click', () => { log('stop click'); stopRecording(); });

    ttsBtn?.addEventListener('click', () => { log('tts click'); speak('Hey—Keilani TTS is live.'); });

    convBtn?.addEventListener('click', () => {
      log('start conversation click');
      loopMode = true;
      startRecording();
    });
  });

  // expose for console
  window.startRecording = () => { loopMode = true; startRecording(); };
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
