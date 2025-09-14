// public/assets/chat.js
// Keilani Brain — chat + PTT with WAV fallback for STT

// ----------------------------
// tiny helpers & UI bindings
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

// central logger for quick triage
function log(...args) { console.log('[keilani]', ...args); }

// ----------------------------
// chat streaming (SSE) → /api/chat-stream
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
      } catch {}
    }
  }
  return assembled;
}

// ----------------------------
// single-voice ElevenLabs TTS via /api/tts
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
  const voiceId = ui.voicePick?.value?.trim();
  if (!voiceId) return;
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
      log('TTS error', r.status, await r.text().catch(() => ''));
      return;
    }
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    ui.ttsPlayer.src = url;
    ui.ttsPlayer.currentTime = 0;
    await ui.ttsPlayer.play().catch((e) =>
      log('Autoplay blocked; click Speak Reply', e?.message || e)
    );
  } finally {
    speakLock = false;
  }
}
ui.ttsPlayer?.addEventListener('ended', cancelPlayback);

// ----------------------------
// PTT recording with WAV fallback
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
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return ''; // let browser choose
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      resolve(s.includes(',') ? s.split(',')[1] : s);
    };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// ---- WAV encoder helpers
function floatTo16BitPCM(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    output.setInt16(offset, s, true);
  }
}
function writeWavHeader(view, sampleRate, numSamples) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // subchunk1Size
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
}
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

async function blobToWav16kMono(blob) {
  // decode → downmix mono → resample to 16000 → PCM16 WAV
  const ab = await blob.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuf = await ac.decodeAudioData(ab);

  // downmix to mono
  const length = audioBuf.length;
  const ch0 = audioBuf.getChannelData(0);
  let mono = new Float32Array(length);
  if (audioBuf.numberOfChannels === 1) {
    mono = ch0;
  } else {
    // average channels
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
        sum += audioBuf.getChannelData(ch)[i];
      }
      mono[i] = sum / audioBuf.numberOfChannels;
    }
  }

  // resample to 16k
  const srcRate = audioBuf.sampleRate;
  const targetRate = 16000;
  const ratio = srcRate / targetRate;
  const newLen = Math.round(mono.length / ratio);
  const resampled = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    resampled[i] = mono[Math.floor(i * ratio)] || 0;
  }

  // encode WAV
  const buffer = new ArrayBuffer(44 + resampled.length * 2);
  const view = new DataView(buffer);
  writeWavHeader(view, targetRate, resampled.length);
  floatTo16BitPCM(view, 44, resampled);

  await ac.close().catch(() => {});
  return new Blob([view], { type: 'audio/wav' });
}

// ---- STT call with WAV fallback
async function sendToSTT(blob, meta) {
  // try original
  const base64 = await blobToBase64(blob);
  const payloadA = { audioBase64: base64, mime: blob.type || 'audio/webm', ...meta };
  log('STT attempt A', { mime: payloadA.mime, size: blob.size, ...meta });

  let r = await fetch('/api/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadA),
  });

  let text = '';
  if (r.ok) {
    const j = await r.json().catch(() => ({}));
    text = (j?.text || '').trim();
  } else {
    log('STT A HTTP', r.status, await r.text().catch(() => ''));
  }

  if (text) return text;

  // fallback to WAV16k mono
  const wav = await blobToWav16kMono(blob);
  const b64wav = await blobToBase64(wav);
  const payloadB = { audioBase64: b64wav, mime: 'audio/wav', ...meta };
  log('STT attempt B (wav16k)', { mime: payloadB.mime, size: wav.size, ...meta });

  r = await fetch('/api/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadB),
  });

  if (!r.ok) {
    log('STT B HTTP', r.status, await r.text().catch(() => ''));
    return '';
  }
  const j2 = await r.json().catch(() => ({}));
  return (j2?.text || '').trim();
}

// ---- Recording control
function pickTimeslice() { return 100; } // ms

function cleanupRecording() {
  try { rec.stream?.getTracks()?.forEach(t => t.stop()); } catch {}
  rec.stream = null; rec.recorder = null; rec.chunks = []; rec.startedAt = 0;
}

async function startRecording() {
  if (recording) return;
  recording = true;
  setState('recording…');

  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    rec.recorder = mime ? new MediaRecorder(rec.stream, { mimeType: mime }) : new MediaRecorder(rec.stream);
    rec.chunks = []; rec.startedAt = performance.now();

    rec.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) rec.chunks.push(e.data);
    };

    rec.recorder.onstop = async () => {
      try { rec.recorder.requestData?.(); } catch {}
      const durMs = performance.now() - rec.startedAt;
      const type = rec.recorder?.mimeType || 'unknown';
      const size = rec.chunks.reduce((n, b) => n + b.size, 0);
      log('recording stopped', { type, durMs: Math.round(durMs), parts: rec.chunks.length, size });

      if (!rec.chunks.length || durMs < 250) {
        ui.transcriptBox.textContent = '(no speech)';
        setState('idle'); cleanupRecording(); return;
      }

      const blob = new Blob(rec.chunks, { type });
      rec.chunks = [];

      const text = await sendToSTT(blob, { durMs: Math.round(durMs) });
      ui.transcriptBox.textContent = text || '(no speech)';

      if (text) {
        await runChat(text);
      } else {
        setState('idle');
      }
    };

    rec.recorder.start(pickTimeslice());
  } catch (e) {
    log('mic error', e);
    setState('idle'); recording = false;
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  try {
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  } catch {}
  cleanupRecording();
}

// ----------------------------
// chat trigger
async function runChat(userText) {
  const text = (userText ?? ui.textIn.value || '').toString().trim();
  if (!text) return;
  setState('thinking…');
  ui.reply.textContent = '';

  let final = '';
  try {
    final = await chatStream(text, (partial) => { ui.reply.textContent = partial; });
  } catch (e) {
    ui.reply.textContent = `Error: ${e.message}`;
    setState('idle');
    return;
  }

  if (final && ui.voicePick?.value) { await speak(final); }
  setState('idle');
}

// ----------------------------
// UI wiring
ui.sendBtn?.addEventListener('click', () => runChat());
ui.speakBtn?.addEventListener('click', () => {
  const text = ui.reply.textContent.trim();
  if (text) speak(text);
});

ui.pttBtn?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ui.pttBtn.setPointerCapture?.(e.pointerId);
  startRecording();
});
ui.pttBtn?.addEventListener('pointerup', (e) => { e.preventDefault(); stopRecording(); });
ui.pttBtn?.addEventListener('pointercancel', stopRecording);
ui.pttBtn?.addEventListener('lostpointercapture', stopRecording);

setState('idle');
log('chat.js ready');
