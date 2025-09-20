// CHAT.JS BUILD TAG → 2025-09-18T18:45Z (guarded DOM bindings + robust flow)

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

  // ---------- audio helpers ----------
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

  async function speak(text, opts = {}) {
    const payload = {
      text: String(text || ''),
      // You can include emotion knobs here if you want frontend control:
      // emotion: { stability: 0.55, similarity: 0.75, style: 0.45 }
    };

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
    try {
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      log('TTS played', blob.size, 'bytes');
    } finally {
      /* url revoked on ended */
    }
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

    const body = {
      audioBase64: base64,
      language: 'en',
      mime: simpleMime,
      filename
    };

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

  // ---------- recorder ----------
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let autoStopTimer = null;

  const AUTO_STOP_MS = 6000; // conservative; adjust to taste
  function clearAutoStop() { if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; } }
  function stopTracks() {
    try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    mediaStream = null;
  }

  async function startRecording() {
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

      mediaRecorder.onerror = (e) => {
        log('recorder error', String(e?.error || e?.name || e));
      };

      mediaRecorder.onstop = async () => {
        clearAutoStop();
        const blob = new Blob(chunks, { type: preferredMime });
        log('final blob', blob.type, blob.size, 'bytes');
        stopTracks();

        if (blob.size < 8192) {
          log('too small; record longer before stopping.');
          mediaRecorder = null; chunks = [];
          return;
        }

        try {
          // 1) STT
          const stt = await sttUploadBlob(blob);
          const transcript = (stt?.transcript || '').trim();
          log('TRANSCRIPT:', transcript);

          if (!transcript) return;

          // 2) CHAT
          const chat = await askLLM(transcript, 'global');

          // 3) TTS
          await speak(chat?.reply || 'Okay.');

        } catch (err) {
          log('STT/CHAT failed', String(err?.message || err));
        } finally {
          mediaRecorder = null;
          chunks = [];
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
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      log('recording stopped (manual)');
      return;
    }
    log('stop click with no active recorder');
  }

  // ---------- DOM binding (guarded) ----------
  function bindUI() {
    const btnRecord = document.getElementById('recordBtn');
    const btnStop   = document.getElementById('stopBtn');
    const btnSay    = document.getElementById('sayBtn');

    if (!btnRecord) log('WARN: #recordBtn not found – record will be unavailable.');
    if (!btnStop)   log('WARN: #stopBtn not found – stop will be unavailable.');
    if (!btnSay)    log('WARN: #sayBtn not found – speak test will be unavailable.');

    btnRecord?.addEventListener('click', () => { log('record click'); startRecording(); });
    btnStop?.addEventListener('click',   () => { log('stop click');   stopRecording();  });
    btnSay?.addEventListener('click',    () => { log('tts click');    speak('Hey — Keilani is live.'); });

    log('DOMContentLoaded; wiring handlers');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUI, { once: true });
  } else {
    // In case script is at end of body, still safe
    bindUI();
  }

  // expose for console testing
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
