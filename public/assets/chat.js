// public/assets/chat.js
// -----------------------------------------------------------------------------
// tiny helpers
const $ = (id) => document.getElementById(id);
const ui = {
  textIn: $('textIn'),
  reply: $('reply'),
  transcriptBox: $('transcriptBox'),
  voicePick: $('voicePick'),
  sendBtn: $('sendBtn'),
  speakBtn: $('speakBtn'),
  pttBtn: $('pttBtn'),
  statePill: $('statePill'),
  ttsPlayer: $('ttsPlayer'),
};
const setState = (s) => (ui.statePill.textContent = s);

// -----------------------------------------------------------------------------
// streaming chat over SSE (/api/chat-stream)
async function chatStream(message, onPartial) {
  const res = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) throw new Error(`chat-stream HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let assembled = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunk = dec.decode(value, { stream: true });
    for (const frame of chunk.split('\n\n')) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '[DONE]' || payload === '{}') continue;

      try {
        const j = JSON.parse(payload);
        const delta = j?.choices?.[0]?.delta?.content || '';
        if (delta) {
          assembled += delta;
          onPartial?.(assembled);
        }
      } catch {
        /* keep-alives etc. */
      }
    }
  }
  return assembled;
}

// -----------------------------------------------------------------------------
// single-voice TTS via /api/tts (ElevenLabs)
let speakLock = false;
let currentTTSAbort = null;

function cancelPlayback() {
  try {
    ui.ttsPlayer.pause();
    if (ui.ttsPlayer.src && ui.ttsPlayer.src.startsWith('blob:')) {
      URL.revokeObjectURL(ui.ttsPlayer.src);
    }
    ui.ttsPlayer.src = '';
  } catch {}
}

async function speak(text) {
  const voiceId = ui.voicePick.value.trim();
  if (!voiceId) return; // silent if no voice chosen

  if (currentTTSAbort) currentTTSAbort.abort();
  currentTTSAbort = new AbortController();
  if (speakLock) return;
  speakLock = true;

  try {
    cancelPlayback();

    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: currentTTSAbort.signal,
      body: JSON.stringify({ text, voiceId }),
    });
    if (!r.ok) {
      console.error('TTS error', r.status, await r.text().catch(() => ''));
      return;
    }
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    ui.ttsPlayer.src = url;
    ui.ttsPlayer.currentTime = 0;
    await ui.ttsPlayer.play().catch((e) =>
      console.warn('Autoplay blocked; click Speak Reply', e?.message)
    );
  } finally {
    speakLock = false;
  }
}
ui.ttsPlayer?.addEventListener('ended', cancelPlayback);

// -----------------------------------------------------------------------------
// push-to-talk (MediaRecorder) → /api/stt → chat stream → (optional) TTS
let rec = { stream: null, recorder: null, chunks: [], startedAt: 0 };
let recording = false;

function pickMime() {
  const CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg',
  ];
  for (const m of CANDIDATES) {
    try {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
    } catch {}
  }
  return ''; // let browser choose
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const base64 = s.includes(',') ? s.split(',')[1] : s;
      resolve(base64);
    };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function startRecording() {
  if (recording) return;
  recording = true;
  setState('recording…');

  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    rec.recorder = mime
      ? new MediaRecorder(rec.stream, { mimeType: mime, audioBitsPerSecond: 128000 })
      : new MediaRecorder(rec.stream);
    rec.chunks = [];
    rec.startedAt = performance.now();

    rec.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) rec.chunks.push(e.data);
    };

    rec.recorder.onstop = async () => {
      try {
        // flush last buffer
        try { rec.recorder.requestData?.(); } catch {}

        const durMs = performance.now() - rec.startedAt;
        if (!rec.chunks.length || durMs < 250) {
          ui.transcriptBox.textContent = '(no speech)';
          setState('idle');
          cleanupRecording();
          return;
        }

        const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/webm' });
        rec.chunks = [];

        const b64 = await blobToBase64(blob);

        const sttRes = await fetch('/api/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // server can detect mime from header in many setups; if yours needs it:
            // mime: rec.recorder.mimeType,
            audioBase64: b64,
          }),
        });

        if (!sttRes.ok) {
          console.error('STT HTTP', sttRes.status, await sttRes.text().catch(() => ''));
          ui.transcriptBox.textContent = "Couldn't transcribe. Try again.";
          setState('idle');
          cleanupRecording();
          return;
        }

        const j = await sttRes.json().catch(() => ({}));
        const text = (j?.text || '').trim();
        ui.transcriptBox.textContent = text || '(no speech)';

        if (text) await runChat(text);
        else setState('idle');
      } catch (err) {
        console.error('STT fatal', err);
        ui.transcriptBox.textContent = "Couldn't transcribe. Try again.";
        setState('idle');
      } finally {
        cleanupRecording();
      }
    };

    // start with small timeslice to get frequent buffers
    rec.recorder.start(100);
  } catch (e) {
    console.error('mic error', e);
    setState('idle');
    recording = false;
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  try {
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  } catch {}
}

function cleanupRecording() {
  try {
    rec.stream?.getTracks()?.forEach((t) => t.stop());
  } catch {}
  rec.stream = null;
  rec.recorder = null;
  rec.chunks = [];
}

// -----------------------------------------------------------------------------
// main chat trigger (textarea or STT)
async function runChat(userText) {
  const text = (userText ?? ui.textIn.value || '').toString().trim();
  if (!text) return;
  setState('thinking…');
  ui.reply.textContent = '';

  let final = '';
  try {
    final = await chatStream(text, (partial) => {
      ui.reply.textContent = partial;
    });
  } catch (e) {
    console.error('chat-stream', e);
    ui.reply.textContent = `Error: ${e.message}`;
    setState('idle');
    return;
  }

  if (final && ui.voicePick.value) {
    await speak(final);
  }
  setState('idle');
}

// -----------------------------------------------------------------------------
// wire up UI
ui.sendBtn?.addEventListener('click', () => runChat());
ui.speakBtn?.addEventListener('click', () => {
  const text = ui.reply.textContent.trim();
  if (text) speak(text);
});

// pointer events make press/hold consistent across mouse/touch/pen
ui.pttBtn?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ui.pttBtn.setPointerCapture?.(e.pointerId);
  startRecording();
});
ui.pttBtn?.addEventListener('pointerup', (e) => {
  e.preventDefault();
  stopRecording();
});

// be extra cautious—stop if pointer leaves the button
ui.pttBtn?.addEventListener('pointercancel', stopRecording);
ui.pttBtn?.addEventListener('lostpointercapture', stopRecording);

// initial
setState('idle');
