// CHAT.JS BUILD TAG → 2025-09-19T09:55-0700

(() => {
  const API_ORIGIN = location.origin; // same origin (api.keilani.ai)

  // --- Core endpoints ---
  const STT_URL    = `${API_ORIGIN}/.netlify/functions/stt`;
  const TTS_URL    = `${API_ORIGIN}/.netlify/functions/tts`;

  // --- Memory endpoints (from #3) ---
  const MEM_SEARCH = `${API_ORIGIN}/.netlify/functions/memory-search`;
  const MEM_UPSERT = `${API_ORIGIN}/.netlify/functions/memory-upsert`;

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

  // ===== User identity for memory =====
  const urlUid = new URLSearchParams(location.search).get('uid');
  const LS_KEY = 'keilani_user_id';
  function uuidv4() {
    // RFC4122-ish using crypto
    const a = crypto.getRandomValues(new Uint8Array(16));
    a[6] = (a[6] & 0x0f) | 0x40; // version 4
    a[8] = (a[8] & 0x3f) | 0x80; // variant
    const h = [...a].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }
  let user_id =
    (urlUid && urlUid.trim()) ||
    localStorage.getItem(LS_KEY) ||
    'global'; // fallback for demos

  if (!urlUid && !localStorage.getItem(LS_KEY)) {
    // if you prefer per-browser identity instead of 'global', uncomment:
    // user_id = uuidv4();
    // localStorage.setItem(LS_KEY, user_id);
  }

  log('user_id ⇒', user_id);

  // ===== Recorder state =====
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let autoStopTimer = null;
  const AUTO_STOP_MS = 6000; // auto-stop after 6s so onstop always fires during tests

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

    if (!res.ok) {
      throw new Error(`STT ${res.status}: ${JSON.stringify(data)}`);
    }
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
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    log('TTS played', blob.size, 'bytes');
  }

  // ===== Memory helpers =====
  async function memorySearch(query, limit = 6) {
    try {
      const res = await fetch(MEM_SEARCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id, query, limit })
      });
      const data = await res.json().catch(() => ({}));
      log('MEM search status', res.status, data);
      if (!res.ok) throw new Error(data?.error || `search ${res.status}`);
      return data?.matches || [];
    } catch (e) {
      log('MEM search failed:', e.message || String(e));
      return [];
    }
  }

  // Very simple “should we store this?” heuristic for demo purposes.
  function shouldStoreMemory(text) {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    if (t.length < 12) return false; // too short
    if (t.startsWith('remember ') || t.startsWith('note ') || t.startsWith('save ')) return true;
    if (t.includes("my name is ") || t.includes("i prefer ") || t.includes("i like ") || t.includes("timezone")) return true;
    return false;
  }

  async function memoryUpsert(content) {
    try {
      const res = await fetch(MEM_UPSERT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id, content })
      });
      const data = await res.json().catch(() => ({}));
      log('MEM upsert status', res.status, data);
      if (!res.ok) throw new Error(data?.error || `upsert ${res.status}`);
      return data;
    } catch (e) {
      log('MEM upsert failed:', e.message || String(e));
      return null;
    }
  }

  function clearAutoStop() {
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
  }

  function stopTracks() {
    try {
      mediaStream?.getTracks()?.forEach(t => t.stop());
    } catch {}
    mediaStream = null;
  }

  // ===== Recording controls =====
  async function startRecording() {
    // Before a new turn: try recalling context from memory for the *last* text input (if any)
    // You could hook this to a text box; for now we recall on start with a generic probe.
    const recall = await memorySearch('recent preferences or profile');
    if (recall.length) {
      const bullets = recall.map(m => `• ${m.content} (sim ${(m.similarity || 0).toFixed(2)})`).join('\n');
      log('Relevant memories:\n' + bullets);
    } else {
      log('No relevant memories found for this user.');
    }

    // Prevent overlapping sessions
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

        // Always clean up tracks so next Start gets a fresh stream
        stopTracks();

        if (blob.size < 8192) {
          log('too small; record a bit longer before stopping.');
          mediaRecorder = null;
          return;
        }

        try {
          // 1) Transcribe audio
          const r = await sttUploadBlob(blob);
          const transcript = (r?.transcript || '').trim();
          log('TRANSCRIPT:', transcript);

          // 2) Search for related memories using the transcript as the query
          if (transcript) {
            const matches = await memorySearch(transcript, 6);
            if (matches.length) {
              const bullets = matches.map(m => `• ${m.content} (sim ${(m.similarity || 0).toFixed(2)})`).join('\n');
              log('Recall for this turn:\n' + bullets);
            }
          }

          // 3) Conditionally store a memory from this transcript (demo heuristic)
          if (shouldStoreMemory(transcript)) {
            log('Storing memory from transcript…');
            await memoryUpsert(transcript);
          } else {
            log('Transcript not considered a memory (heuristic).');
          }

          // 4) (Optional) echo TTS so you can hear the end-to-end loop
          // await speak(`You said: ${transcript}`);

        } catch (err) {
          console.error(err);
          log('STT or Memory error', String(err && err.message || err));
        } finally {
          mediaRecorder = null;
          chunks = [];
        }
      };

      mediaRecorder.start();
      log('recording started with', preferredMime);

      // Auto-stop after N ms so onstop reliably runs during testing
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
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      log('recording stopped (manual)');
      return;
    }
    log('stop clicked but no active recorder');
  }

  // ===== Wire UI after DOM is ready =====
  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded; wiring handlers');
    const recBtn  = document.querySelector('#recordBtn');
    const stopBtn = document.querySelector('#stopBtn');
    const ttsBtn  = document.querySelector('#sayBtn');

    recBtn?.addEventListener('click', () => { log('record click'); startRecording(); });
    stopBtn?.addEventListener('click', () => { log('stop click'); stopRecording(); });
    ttsBtn?.addEventListener('click', () => { log('tts click'); speak('Hey—Keilani TTS is live.'); });
  });

  // expose for console testing
  window.startRecording = startRecording;
  window.stopRecording  = stopRecording;
  window.speak          = speak;
})();
