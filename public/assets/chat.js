// --- tiny helpers -----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// --- global state/locks -----------------------------------------------------
let media = { stream: null, recorder: null, chunks: [] };
let isRecording = false;

// single-flight guards so we never overlap
let speakLock = false;          // blocks TTS overlap
let currentTTSAbort = null;     // abort current TTS fetch/play

// --- UI state ---------------------------------------------------------------
function setState(text) {
  ui.statePill.textContent = text;
}

// --- chat streaming (SSE over fetch) ---------------------------------------
async function chatStream(message, onPartial) {
  // POST to /api/chat-stream (edge) with SSE body
  const res = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });

  if (!res.ok || !res.body) {
    throw new Error(`chat-stream HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let assembled = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunk = dec.decode(value, { stream: true });

    // Parse SSE frames and pull "data:" JSON lines
    const frames = chunk.split('\n\n');
    for (const f of frames) {
      const line = f.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]' || payload === '{}') continue;

      // the edge function forwards OpenAI’s event chunks (JSON)
      try {
        const j = JSON.parse(payload);
        const delta = j?.choices?.[0]?.delta?.content || '';
        if (delta) {
          assembled += delta;
          onPartial?.(assembled);
        }
      } catch {
        // ignore non-JSON keepalives (e.g., "event: open")
      }
    }
  }
  return assembled;
}

// --- TTS (ElevenLabs only via /api/tts) ------------------------------------
async function speak(text) {
  // if no voice selected -> do nothing (silent)
  const voiceId = ui.voicePick.value.trim();
  if (!voiceId) return;

  // ensure previous request is cancelled
  if (currentTTSAbort) currentTTSAbort.abort();
  currentTTSAbort = new AbortController();

  // single-flight guard
  if (speakLock) return;
  speakLock = true;

  try {
    // stop any current playback first
    cancelPlayback();

    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: currentTTSAbort.signal,
      body: JSON.stringify({ text, voiceId })
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      console.error('TTS error', r.status, errTxt.slice(0, 200));
      return;
    }

    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);

    ui.ttsPlayer.src = url;
    ui.ttsPlayer.currentTime = 0;

    await ui.ttsPlayer.play().catch((e) => {
      console.warn('Autoplay blocked, user gesture needed:', e?.message);
    });
  } finally {
    speakLock = false;
  }
}

// ensure we don’t overlap playback or leak URLs
function cancelPlayback() {
  try {
    ui.ttsPlayer.pause();
    if (ui.ttsPlayer.src && ui.ttsPlayer.src.startsWith('blob:')) {
      URL.revokeObjectURL(ui.ttsPlayer.src);
    }
    ui.ttsPlayer.src = '';
  } catch {}
}

// --- STT (capture mic, push wav to /api/stt, stream reply) ------------------
async function startRecording() {
  if (isRecording) return;
  isRecording = true;
  setState('recording…');

  try {
    // get mic
    media.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    media.recorder = new MediaRecorder(media.stream, { mimeType: 'audio/webm' });
    media.chunks = [];

    media.recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) media.chunks.push(e.data);
    };

    media.recorder.onstop = async () => {
      try {
        setState('processing…');

        // combine chunks -> webm blob
        const blob = new Blob(media.chunks, { type: 'audio/webm' });
        media.chunks = [];

        // turn into base64 for /api/stt
        const arrbuf = await blob.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrbuf)));

        // send to STT
        const sttRes = await fetch('/api/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: base64 })
        });

        if (!sttRes.ok) {
          const t = await sttRes.text().catch(() => '');
          throw new Error(`STT HTTP ${sttRes.status}: ${t.slice(0, 120)}`);
        }

        const j = await sttRes.json();
        const text = (j?.text || '').trim() || '(no speech)';
        ui.transcriptBox.textContent = text;

        // stream the answer
        await runChat(text);
      } catch (err) {
        console.error('STT error:', err);
        ui.transcriptBox.textContent = "Couldn't transcribe. Try again.";
        setState('idle');
      }
    };

    media.recorder.start(100);
  } catch (e) {
    console.error('mic error', e);
    setState('idle');
    isRecording = false;
  }
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  try {
    if (media.recorder && media.recorder.state !== 'inactive') {
      media.recorder.stop();
    }
  } finally {
    // stop tracks
    try {
      media.stream?.getTracks()?.forEach(t => t.stop());
    } catch {}
    media.stream = null;
    media.recorder = null;
  }
}

// --- main chat runner (from text area or STT) -------------------------------
async function runChat(userText) {
  const text = (userText ?? ui.textIn.value || '').toString().trim();
  if (!text) return;

  setState('thinking…');

  // clear UI
  ui.reply.textContent = '';

  // stream tokens to the reply box
  let final = '';
  try {
    final = await chatStream(text, (partial) => {
      ui.reply.textContent = partial;
    });
  } catch (e) {
    console.error('chat-stream error:', e);
    ui.reply.textContent = `Error: ${e.message}`;
    setState('idle');
    return;
  }

  // speak once (only if a voice is picked)
  if (final && ui.voicePick.value) {
    await speak(final);
  }

  setState('idle');
}

// --- wire up buttons --------------------------------------------------------
ui.sendBtn?.addEventListener('click', () => runChat());
ui.speakBtn?.addEventListener('click', () => {
  const text = ui.reply.textContent.trim();
  if (text) speak(text);
});

// push-to-talk: press = record, release = stop
ui.pttBtn?.addEventListener('mousedown', startRecording);
ui.pttBtn?.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); }, { passive: false });

const endPress = () => stopRecording();
ui.pttBtn?.addEventListener('mouseup', endPress);
ui.pttBtn?.addEventListener('mouseleave', endPress);
ui.pttBtn?.addEventListener('touchend', (e) => { e.preventDefault(); endPress(); }, { passive: false });

// clean up audio when it ends (no loops / overlapping)
ui.ttsPlayer?.addEventListener('ended', () => cancelPlayback());

// initial state
setState('idle');
