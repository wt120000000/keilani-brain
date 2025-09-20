// CHAT.JS BUILD TAG → 2025-09-18T19:10Z (loop mode: auto-restart after TTS)

(() => {
  const API_ORIGIN = location.origin;
  const STT_URL    = `${API_ORIGIN}/.netlify/functions/stt`;
  const CHAT_URL   = `${API_ORIGIN}/.netlify/functions/chat`;
  const TTS_URL    = `${API_ORIGIN}/.netlify/functions/tts`;

  // ---------- logger ----------
  const logEl = document.getElementById('log');
  const log = (...args) => {
    console.log('[CHAT]', ...args);
    if (!logEl) return;
    const line = args.map(a => (typeof a === 'object'
      ? JSON.stringify(a, null, 2)
      : String(a))).join(' ');
    logEl.textContent += (logEl.textContent ? '\n' : '') + line;
    logEl.scrollTop = logEl.scrollHeight;
  };

  // ---------- loop / state ----------
  let shouldLoop = false;   // toggled by buttons
  let isSpeaking = false;   // true while audio is playing
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let autoStopTimer = null;

  const AUTO_STOP_MS    = 6000;  // max utterance per turn
  const LOOP_DELAY_MS   = 200;   // small gap before restarting mic

  function clearAutoStop() { if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; } }
  function stopTracks() { try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {} mediaStream = null; }

  // ---------- helpers ----------
  function blobToBase64Raw(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const s = reader.result || '';
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
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
    return data; // { transcript, meta }
  }

  async function askLLM(message, user_id = 'global') {
    const payload = { user_id, message: String(message || '') };
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let data = null;
    try { data = await res.json(); } catch {}
    log('CHAT status', res.status, data);
    if (!res.ok) throw new Error(`CHAT ${res.status}: ${JSON.stringify(data)}`);
    return data; // { reply, ... }
  }

  // Speak returns when playback **finishes**
  async function speak(text) {
    const payload = { text: String(text || '') };
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch {}
      log('TTS error', res.status, detail);
      throw new Error(`TTS ${res.status}`);
    }

    const buf  = await res.arrayBuffer();
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url  = URL.createObjectURL(blob);

    isSpeaking = true;
    try {
      await new Promise((resolve, reject) => {
        const audio = new Audio(url);
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        audio.play().catch(reject);
      });
      log('TTS played', blob.size, 'bytes');
    } finally {
      isSpeaking = false;
    }
  }

  // ---------- recorder ----------
  async function startRecording() {
    // don’t start a new capture while still talking
    if (isSpeaking) {
      log('deferring start; currently speaking');
      setTimeout(() => { if (shouldLoop) startRecording(); }, LOOP_DELAY_MS);
      return;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      log('already recording; ignoring start');
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/ogg;codecs=opus';

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferredMime });
      chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          chunks.push(e.data);
          log('chunk', e.data.type, e.data.size, 'bytes');
        }
      };

      mediaRecorder.onerror = (e) => log('recorder error', String(e?.error || e?.name || e));

      mediaRecorder.onstop = async () => {
        clearAutoStop();
        const blob = new Blob(chunks, { type: preferredMime });
        log('final blob', blob.type, blob.size, 'bytes');
        stopTracks();

        if (blob.size < 8192) {
          log('too small; record longer before stopping.');
          mediaRecorder = null; chunks = [];
          // Even if too small, continue loop so it doesn't stall
          if (shouldLoop) setTimeout(startRecording, LOOP_DELAY_MS);
          return;
        }

        try {
          // 1) STT
          const stt = await sttUploadBlob(blob);
          const transcript = (stt?.transcript || '').trim();
          log('TRANSCRIPT:', transcript);
          if (!transcript) {
            if (shouldLoop) setTimeout(startRecording, LOOP_DELAY_MS);
            return;
          }

          // 2) CHAT
          const chat = await askLLM(transcript, 'global');

          // 3) TTS (await until audio finishes)
          await speak(chat?.reply || 'Okay.');

        } catch (err) {
          log('STT/CHAT failed', String(err?.message || err));
        } finally {
          mediaRecorder = null; chunks = [];
          // Restart conversation turn if loop is enabled
          if (shouldLoop) setTimeout(startRecording, LOOP_DELAY_MS);
        }
      };

      mediaRecorder.start();
      log('recording started with', preferredMime);
      clearAutoStop();
      autoStopTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
          log('recording stopped (auto)');
        }
      }, AUTO_STOP_MS);

    } catch (err) {
      log('mic error', String(err?.message || err));
      stopTracks();
      mediaRecorder = null; chunks = [];
      clearAutoStop();
      if (shouldLoop) setTimeout(startRecording, LOOP_DELAY_MS * 5);
    }
  }

  function stopRecording() {
    // disable loop first, so we don’t auto-restart after TTS
    shouldLoop = false;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      log('recording stopped (manual)');
      return;
    }
    log('stop click with no active recorder');
  }

  // ---------- DOM wiring (guarded) ----------
  function bindUI() {
    const btnRecord = document.getElementById('recordBtn');
    const btnStop   = document.getElementById('stopBtn');
    const btnSay    = document.getElementById('sayBtn');

    if (!btnRecord) log('WARN: #recordBtn not found');
    if (!btnStop)   log('WARN: #stopBtn not found');
    if (!btnSay)    log('WARN: #sayBtn not found');

    btnRecord?.addEventListener('click', () => {
      log('record click');
      shouldLoop = true;       // enable loop-conversation mode
      startRecording();
    });

    btnStop?.addEventListener('click', () => {
      log('stop click');
      stopRecording();
    });

    btnSay?.addEventListener('click', async () => {
      log('tts click');
      // One-shot test; don’t change loop mode
      try { await speak('Hey — Keilani is live.'); } catch (e) { log('TTS test failed', String(e)); }
    });

    log('DOMContentLoaded; wiring handlers');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUI, { once: true });
  } else {
    bindUI();
  }

  // expose for console testing
  window.startRecording = () => { shouldLoop = true; startRecording(); };
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
