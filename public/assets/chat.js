// CHAT.JS BUILD TAG → 2025-09-19T15:10-0700 (fast turn-based, auto-loop)

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
  let autoStopTimer = null;
  const AUTO_STOP_MS = 2000; // ⏱️ 2s utterances for snappy turn-taking
  const USER_ID = "global";
  let loopMode = false; // turn-taking conversation loop

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
        // 🔁 auto-loop: restart mic immediately after she finishes
        if (loopMode) {
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
    if (data.reply) {
      // Mic is stopped at this point; speak, then onended will restart mic if loopMode
      await speak(data.reply);
    }
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

  // ===== Recording (turn-based) =====
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
        console.error('[CHAT] recorder error', e);
        log('recorder error', String(e?.error || e?.name || e));
      };

      mediaRecorder.onstop = async () => {
        clearAutoStop();
        const blob = new Blob(chunks, { type: preferredMime });
        log('final blob', blob.type, blob.size, 'bytes');

        // Always clean up tracks before STT/LLM/TTS
        stopTracks();

        if (blob.size < 6000) {
          log('too small; record a bit longer before stopping.');
          mediaRecorder = null;
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

      mediaRecorder.start(); // no timeslice: we’ll stop after AUTO_STOP_MS once
      log('recording started with', preferredMime);

      // Faster turn-taking window
      clearAutoStop();
      autoStopTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          log('auto-stop timer fired');
          mediaRecorder.stop();
          log('recording stopped (auto)');
        }
      }, AUTO_STOP_MS);

    } catch (err) {
      console.error(err);
      log('mic error', String(err && err.message || err));
      stopTracks();
      mediaRecorder = null;
      chunks = [];
      clearAutoStop();
    }
  }

  function stopRecording() {
    loopMode = false; // stop loop if manually halted
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      log('recording stopped (manual)');
      return;
    }
    log('stop clicked but no active recorder');
  }

  // ===== Wire UI =====
  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded; wiring handlers');
    const recBtn  = document.querySelector('#recordBtn');
    const stopBtn = document.querySelector('#stopBtn');
    const ttsBtn  = document.querySelector('#sayBtn');
    const convBtn = document.querySelector('#convBtn'); // optional "Start Conversation"

    recBtn?.addEventListener('click', () => { log('record click'); startRecording(); });
    stopBtn?.addEventListener('click', () => { log('stop click'); stopRecording(); });
    ttsBtn?.addEventListener('click', () => { log('tts click'); speak('Hey—Keilani TTS is live.'); });

    convBtn?.addEventListener('click', () => {
      log('start conversation click');
      loopMode = true;
      startRecording();
    });
  });

  // expose for console
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
