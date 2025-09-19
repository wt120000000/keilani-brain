// CHAT.JS BUILD TAG → 2025-09-19T14:15-0700
(() => {
  const API_ORIGIN = location.origin;
  const STT_URL = `${API_ORIGIN}/.netlify/functions/stt`;
  const TTS_URL = `${API_ORIGIN}/.netlify/functions/tts`;
  const CHAT_URL = `${API_ORIGIN}/.netlify/functions/chat`;

  const logEl = document.getElementById('log');
  const log = (...args) => {
    console.log('[CHAT]', ...args);
    if (logEl) {
      const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
      logEl.textContent += (logEl.textContent ? '\n' : '') + line;
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  const USER_ID = "global";
  let duplexMode = false;

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

    const body = { audioBase64: base64, language: 'en', mime: simpleMime };
    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    log('STT status', res.status, data);
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
    if (!res.ok) throw new Error(`TTS ${res.status}`);

    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    audio.play();
    log('TTS played', blob.size, 'bytes');
    audio.onended = () => URL.revokeObjectURL(url);
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
    if (data.reply) {
      await speak(data.reply);
    }
  }

  async function startRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') return;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/ogg;codecs=opus';

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: preferredMime });

      mediaRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 4000) {
          const blob = new Blob([e.data], { type: preferredMime });
          try {
            const r = await sttUploadBlob(blob);
            if (r.transcript) {
              log('TRANSCRIPT:', r.transcript);
              askLLM(r.transcript);
            }
          } catch (err) {
            log('STT chunk failed', String(err.message || err));
          }
        }
      };

      mediaRecorder.start(2000); // 🔥 send chunks every 2s
      log('recording started duplex with', preferredMime);
    } catch (err) {
      console.error(err);
      log('mic error', String(err && err.message || err));
      stopRecording();
    }
  }

  function stopRecording() {
    duplexMode = false;
    try { mediaRecorder?.stop(); } catch {}
    try { mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
    mediaRecorder = null;
    mediaStream = null;
  }

  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded; wiring handlers');
    const recBtn  = document.querySelector('#recordBtn');
    const stopBtn = document.querySelector('#stopBtn');
    const convBtn = document.querySelector('#convBtn');

    recBtn?.addEventListener('click', () => { log('record click'); startRecording(); });
    stopBtn?.addEventListener('click', () => { log('stop click'); stopRecording(); });
    convBtn?.addEventListener('click', () => {
      log('duplex conversation click');
      duplexMode = true;
      startRecording();
    });
  });

  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
})();
