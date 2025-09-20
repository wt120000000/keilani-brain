// public/assets/chat.js
// BUILD TAG → 2025-09-19T22:07-0700 (Hardened STT fetch: timeout, retry, dual endpoints; emotion plumb)

(() => {
  const API_ORIGIN = location.origin;

  // Try function path first, then pretty redirect as fallback.
  const STT_URLS  = [`${API_ORIGIN}/.netlify/functions/stt`, `${API_ORIGIN}/api/stt`];
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

  // ===== AFFECT (persist per-device) =====
  let affect = null;
  try { affect = JSON.parse(localStorage.getItem('affect') || 'null'); } catch {}
  if (!affect) affect = { mood:"calm", valence:0, arousal:0.25, intensity:0.25, since:new Date().toISOString(), decay:{half_life_sec:600} };
  const saveAffect = (a) => { affect = a || affect; try { localStorage.setItem('affect', JSON.stringify(affect)); } catch {} };

  // ===== Recorder / VAD (fast) =====
  let mediaRecorder = null, mediaStream = null, chunks = [];
  let audioCtx = null, analyser = null, sourceNode = null, vadTimer = null;
  const FAST = {
    MIN_CAPTURE_MS : 1200,
    SPEECH_MIN_MS  : 700,
    SILENCE_MS     : 900,
    VAD_INTERVAL   : 60,
    RMS_THRESH     : 9,
    START_HOLD_MS  : 160,
    BPS            : 64000,
    MAX_CAPTURE_MS : 9000,
  };
  const USER_ID = "global";
  let loopMode = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // Generic fetch with timeout and backoff
  async function fetchJsonWithTimeout(url, opts, timeoutMs, attempt, totalAttempts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store', keepalive: false, credentials: 'omit' });
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      const body = isJson ? await res.json().catch(() => null) : null;
      return { ok: res.ok, status: res.status, data: body };
    } catch (e) {
      log(`fetch error on ${url} (attempt ${attempt}/${totalAttempts}) →`, String(e && e.message || e));
      return { ok: false, status: 0, data: { error: String(e && e.message || e) } };
    } finally {
      clearTimeout(t);
    }
  }

  // Try all STT endpoints with retry/backoff
  async function sttUploadBlob(blob) {
    const base64 = await blobToBase64Raw(blob);
    const simpleMime = (blob.type || '').split(';')[0] || 'application/octet-stream';
    const filename =
      simpleMime.includes('webm') ? 'audio.webm' :
      simpleMime.includes('ogg')  ? 'audio.ogg'  :
      simpleMime.includes('mpeg') || simpleMime.includes('mp3') ? 'audio.mp3' :
      simpleMime.includes('m4a') || simpleMime.includes('mp4') ? 'audio.m4a' :
      simpleMime.includes('wav')  ? 'audio.wav'  : 'audio.bin';

    const body = JSON.stringify({ audioBase64: base64, language: 'en', mime: simpleMime, filename });

    // up to 2 attempts per URL
    for (let i = 0; i < STT_URLS.length; i++) {
      const url = STT_URLS[i];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await fetchJsonWithTimeout(
          url,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
          15000,
          attempt,
          2
        );
        if (res.ok) {
          log('STT status', res.status, res.data, `via ${i === 0 ? 'functions path' : 'redirect path'}`);
          return res.data;
        }
        // Retry on network/timeout/429/5xx
        if (res.status === 0 || res.status === 429 || res.status >= 500) {
          const wait = 300 + Math.random() * 500;
          await sleep(wait);
          continue;
        }
        // Non-retryable error; throw
        throw new Error(`STT ${res.status}: ${JSON.stringify(res.data)}`);
      }
      log(`STT: switching endpoint to fallback: ${STT_URLS[i+1] || '(none)'}`);
    }
    throw new Error('STT failed across endpoints');
  }

  function ttsOptsFromAffect(a) {
    return { emotion_state: a };
  }

  async function speak(text, opts = {}) {
    const payload = {
      text: String(text || 'Hello, Keilani here.'),
      format: 'mp3',
      emotion_state: opts.emotion_state || affect
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort('timeout'), 15000);
      try {
        const res = await fetch(TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'omit',
        });
        const buf = await res.arrayBuffer();
        if (!res.ok) {
          let detail = '';
          try { detail = JSON.parse(new TextDecoder().decode(buf)); } catch {}
          log('TTS error', res.status, detail || new TextDecoder().decode(buf));
          if ((res.status === 429 || res.status >= 500) && attempt === 1) {
            await sleep(400 + Math.random() * 400);
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
      } catch (e) {
        log('TTS fetch exception', String(e && e.message || e));
        if (attempt === 1) { await sleep(350 + Math.random() * 300); }
      } finally { clearTimeout(t); }
    }
    throw new Error('TTS failed');
  }

  async function askLLM(transcript) {
    const payload = { user_id: USER_ID, message: transcript, emotion_state: affect };

    const res = await fetchJsonWithTimeout(
      CHAT_URL,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
      15000,
      1,
      1
    );

    log('CHAT status', res.status, res.data);
    if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(res.data)}`);

    if (res.data?.next_emotion_state) saveAffect(res.data.next_emotion_state);
    if (res.data?.reply) await speak(res.data.reply, ttsOptsFromAffect(affect));
  }

  function cleanupVAD() {
    if (vadTimer) { clearTimeout(vadTimer); vadTimer = null; }
    try { sourceNode?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}
    sourceNode = null; analyser = null;
  }

  function stopTracks() {
    try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    mediaStream = null;
  }

  async function startRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') { log('already recording; ignoring start'); return; }
    stopTracks(); cleanupVAD(); chunks = [];

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/ogg;codecs=opus';

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferredMime, audioBitsPerSecond: FAST.BPS });

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onerror = (e) => { console.error('[CHAT] recorder error', e); log('recorder error', String(e?.error || e?.name || e)); };

      mediaRecorder.onstop = async () => {
        cleanupVAD();
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        log('final blob', blob.type, blob.size, 'bytes');
        stopTracks();

        if (blob.size < 8500) {
          log('too small; record a bit longer.');
          mediaRecorder = null; chunks = [];
          if (loopMode) startRecording();
          return;
        }

        try {
          // STT → CHAT → TTS
          const r = await sttUploadBlob(blob);
          log('TRANSCRIPT:', r.transcript);
          await askLLM(r.transcript);
        } catch (err) {
          console.error(err);
          log('STT/CHAT failed', String(err && err.message || err));
          // If STT path had a transient outage, keep loop alive so user can try again
          if (loopMode) { await sleep(300); startRecording(); }
        } finally {
          mediaRecorder = null; chunks = [];
        }
      };

      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024;
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      let lastSpeechAt = startedAt, speechStarted = false, speechStartCandidateAt = null;

      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) { const d = buf[i] - 128; sumSq += d * d; }
        const rms = Math.sqrt(sumSq / buf.length);

        const now = performance.now();
        const elapsed = now - startedAt;

        if (rms >= FAST.RMS_THRESH) {
          if (!speechStartCandidateAt) speechStartCandidateAt = now;
          if (!speechStarted && now - speechStartCandidateAt >= FAST.START_HOLD_MS) {
            speechStarted = true; log('VAD: speech started (fast)');
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

        const stopByMax = elapsed >= FAST.MAX_CAPTURE_MS;

        if (stopBySilence || stopByMax) {
          try { if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); log(`recording stopped (${stopBySilence ? 'silence' : 'max'})`); } }
          catch {}
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
      cleanupVAD(); stopTracks(); mediaRecorder = null; chunks = [];
    }
  }

  function stopRecording() {
    loopMode = false;
    try {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop(); log('recording stopped (manual)');
      } else {
        log('stop clicked but no active recorder');
      }
    } catch {}
    cleanupVAD(); stopTracks();
  }

  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded; wiring handlers');
    const recBtn  = document.querySelector('#recordBtn');
    const stopBtn = document.querySelector('#stopBtn');
    const ttsBtn  = document.querySelector('#sayBtn');
    const convBtn = document.querySelector('#convBtn');

    recBtn?.addEventListener('click', () => { loopMode = true; log('record click → loopMode ON'); startRecording(); });
    stopBtn?.addEventListener('click', () => { log('stop click'); stopRecording(); });
    ttsBtn?.addEventListener('click', () => { log('tts click'); speak('Hey—Keilani TTS is live.', ttsOptsFromAffect(affect)); });
    convBtn?.addEventListener('click', () => { log('start conversation click'); loopMode = true; startRecording(); });
  });

  // expose for console
  window.startRecording = () => { loopMode = true; startRecording(); };
  window.stopRecording  = stopRecording;
  window.speak          = (t) => speak(t, ttsOptsFromAffect(affect));
})();
