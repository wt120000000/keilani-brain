// CHAT.JS BUILD TAG → 2025-09-19T17:45-0700 (Fast profile: quicker VAD + lower bitrate)

(() => {
  const API_ORIGIN = location.origin;
  const STT_URL   = `${API_ORIGIN}/.netlify/functions/stt`;
  const TTS_URL   = `${API_ORIGIN}/.netlify/functions/tts`;
  const CHAT_URL  = `${API_ORIGIN}/.netlify/functions/chat`;

  const logEl = document.getElementById('log');
  const log = (...args) => {
    console.log('[CHAT]', ...args);
    if (logEl) {
      const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
      logEl.textContent += (logEl.textContent ? '\n' : '') + line;
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  // ===== Fast profile knobs =====
  // Trimmed vs prior build (was SILENCE_MS=1300, START_HOLD_MS=220, MIN_CAPTURE_MS=1600)
  const FAST = {
    MIN_CAPTURE_MS : 1200,  // was 1600
    SPEECH_MIN_MS  : 700,   // was 800
    SILENCE_MS     : 900,   // was 1300
    VAD_INTERVAL   : 60,    // was 75
    RMS_THRESH     : 9,     // leave as-is; bump to 10–12 if noisy
    START_HOLD_MS  : 160,   // was 220
    BPS            : 64000, // 64 kbps Opus (smaller upload, still intelligible)
  };

  // ===== State =====
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];

  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let vadTimer = null;

  const USER_ID = "global";
  let loopMode = true;

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

    // tiny retry for 429
    for (let attempt = 0; attempt < 2; attempt++) {
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
        if (res.status === 429 && attempt === 0) {
          await new Promise(r => setTimeout(r, 450 + Math.random() * 350));
          continue;
        }
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
    if (vadTimer) { clearTimeout(vadTimer); vadTimer = null; }
    try { sourceNode?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}
    sourceNode = null;
    analyser = null;
  }

  function stopTracks() {
    try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    mediaStream = null;
  }

  // ===== Recording with faster VAD =====
  async function startRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      log('already recording; ignoring start');
      return;
    }
    stopTracks();
    cleanupVAD();
    chunks = [];

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/ogg;codecs=opus';

      // lower bitrate -> smaller upload -> faster STT
      mediaRecorder = new MediaRecorder(mediaStream, {
        mimeType: preferredMime,
        audioBitsPerSecond: FAST.BPS
      });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          chunks.push(e.data);
          // keep logs light
          // log('chunk', e.data.type, e.data.size, 'bytes');
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

        if (blob.size < 8500) {
          log('too small; record a bit longer.');
          mediaRecorder = null;
          chunks = [];
          if (loopMode) startRecording();
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

      // WebAudio VAD
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      let lastSpeechAt = startedAt;
      let speechStarted = false;
      let speechStartCandidateAt = null;

      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const dev = buf[i] - 128;
          sumSq += dev * dev;
        }
        const rms = Math.sqrt(sumSq / buf.length);

        const now = performance.now();
        const elapsed = now - startedAt;

        if (rms >= FAST.RMS_THRESH) {
          if (!speechStartCandidateAt) speechStartCandidateAt = now;
          if (!speechStarted && now - speechStartCandidateAt >= FAST.START_HOLD_MS) {
            speechStarted = true;
            log('VAD: speech started (fast)');
          }
          lastSpeechAt = now;
        } else {
          speechStartCandidateAt = null;
        }

        const silenceDur = now - lastSpeechAt;
        const speechDur = speechStarted ? (lastSpeechAt - startedAt) : 0;

        const stopBySilence =
          elapsed >= FAST.MIN_CAPTURE_MS &&
          speechStarted &&
          speechDur >= FAST.SPEECH_MIN_MS &&
          silenceDur >= FAST.SILENCE_MS;

        const stopByMax = elapsed >= 9000; // keep a ceiling

        if (stopBySilence || stopByMax) {
          try {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
              log(`recording stopped (${stopBySilence ? 'silence' : 'max'})`);
            }
          } catch (e) {}
          return;
        }

        vadTimer = setTimeout(tick, FAST.VAD_INTERVAL);
      };

      mediaRecorder.start();
      log('recording started with', mediaRecorder.mimeType, '(VAD, fast)');
      vadTimer = setTimeout(tick, FAST.VAD_INTERVAL);

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

  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded; wiring handlers');
    const recBtn  = document.querySelector('#recordBtn');
    const stopBtn = document.querySelector('#stopBtn');
    const ttsBtn  = document.querySelector('#sayBtn');
    const convBtn = document.querySelector('#convBtn');

    recBtn?.addEventListener('click', () => {
      loopMode = true;
      log('record click → loopMode ON');
      startRecording();
    });

    stopBtn?.addEventListener('click', () => { log('stop click'); stopRecording(); });
    ttsBtn?.addEventListener('click', () => { log('tts click'); speak('Hey—Keilani TTS is live.'); });
    convBtn?.addEventListener('click', () => { log('start conversation click'); loopMode = true; startRecording(); });
  });

  window.startRecording = () => { loopMode = true; startRecording(); };
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
