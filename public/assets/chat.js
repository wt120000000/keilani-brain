/* public/assets/chat.js
   Keilani Brain — Live
   (Edge streaming + voices + PTT + barge-in + session memory + URL user/session overrides)
*/

(() => {
  const $ = (s) => document.querySelector(s);
  const inputEl      = $('#textIn')    || $('#input')  || $('textarea');
  const sendBtn      = $('#sendBtn')   || $('#send');
  const speakBtn     = $('#speakBtn')  || $('#speak');
  const pttBtn       = $('#pttBtn')    || $('#ptt') || $('#holdToTalk');
  const voiceSel     = $('#voicePick') || $('#voice') || $('#voiceSelect');
  const statusPill   = $('#statePill') || $('#status') || $('.status');
  const transcriptEl = $('#transcriptBox') || $('#transcript');
  const replyEl      = $('#reply');

  // ---------- URL helpers ----------
  const qp = new URLSearchParams(location.search);
  const urlUser    = qp.get('user') || '';
  const urlSession = qp.get('session') || '';
  const urlVoice   = qp.get('voice') || '';
  const doReset    = qp.has('reset');

  // ---------- IDs ----------
  function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4))).toString(16)
    );
  }
  const SESSION_KEY = 'kb_session';
  const USER_KEY    = 'kb_user';

  if (doReset) {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    try { localStorage.removeItem(USER_KEY); } catch {}
  }

  function getId(key, prefix, override) {
    if (override) {
      localStorage.setItem(key, override);
      return override;
    }
    let v = localStorage.getItem(key);
    if (!v) { v = `${prefix}-${uuidv4()}`; localStorage.setItem(key, v); }
    return v;
  }

  const userId    = getId(USER_KEY, 'user', urlUser);
  const sessionId = getId(SESSION_KEY, 'sess', urlSession);

  // Apply voice override if present
  if (urlVoice && voiceSel) {
    // If your <select> is populated dynamically, you may want to set this later.
    voiceSel.value = urlVoice;
  }

  // ---------- Audio / TTS ----------
  const player = (() => {
    let el = $('#ttsPlayer') || document.createElement('audio');
    el.id = 'ttsPlayer';
    el.preload = 'none';
    el.controls = true;
    if (!el.parentNode) document.body.appendChild(el);
    return el;
  })();

  let bargeIn = { speaking: false };
  function unlockAudioOnce() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ac = Ctx ? new Ctx() : null;
      if (ac?.state === 'suspended') ac.resume();
      player.muted = false;
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudioOnce, { once: true });

  function setStatus(s) { if (statusPill) statusPill.textContent = s; }
  function getVoice() { return voiceSel?.value || ""; }
  function clear(el) { if (el) el.textContent = ''; }
  function append(el, t) {
    if (!el || !t) return;
    const span = document.createElement('span');
    span.textContent = t;
    el.appendChild(span);
  }
  function stopSpeaking() {
    try { player.pause(); player.currentTime = 0; } catch {}
    bargeIn.speaking = false;
  }

  // Plain TTS via Netlify function (MP3)
  async function speakText(text, voice) {
    if (!text?.trim()) return;
    const resp = await fetch('/.netlify/functions/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!resp.ok) throw new Error('tts_failed');
    const ab = await resp.arrayBuffer();
    const url = URL.createObjectURL(new Blob([ab], { type: 'audio/mpeg' }));
    player.src = url;
    try { bargeIn.speaking = true; await player.play(); } catch (e) { console.warn('[TTS] autoplay?', e); }
  }

  // ---------- Chat Stream (Edge) ----------
  async function chatStream(message, voice) {
    const resp = await fetch('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice, sessionId, userId }),
    });
    if (!resp.ok || !resp.body) {
      const raw = await resp.text().catch(()=> '');
      console.error('[chat-stream] HTTP', resp.status, 'raw=', raw);
      throw new Error('chat_stream_failed');
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let finalText = '';
    clear(replyEl);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta?.content || j.delta || j.content || '';
          if (d) { finalText += d; append(replyEl, d); }
        } catch {
          finalText += data; append(replyEl, data);
        }
      }
    }
    return finalText.trim();
  }

  // ---------- Send (text) ----------
  async function handleSend() {
    try {
      unlockAudioOnce();
      const text = inputEl?.value?.trim();
      if (!text) return;
      setStatus('thinking');
      stopSpeaking();
      const reply = await chatStream(text, getVoice());
      setStatus('speaking');
      await speakText(reply, getVoice());
      setStatus('idle');
    } catch (e) {
      console.error('[SEND] error', e);
      setStatus('idle');
    }
  }

  // ---------- PTT / STT ----------
  let mediaStream = null, mediaRecorder = null, chunks = [];
  function mimePick() {
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    return 'audio/webm';
  }
  function toB64(buf) {
    let bin = '', bytes = new Uint8Array(buf);
    for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function startPTT() {
    try {
      unlockAudioOnce();
      stopSpeaking(); // barge-in
      setStatus('listening');
      chunks = [];
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 }
      });
      const mime = mimePick();
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });
      mediaRecorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      mediaRecorder.onstop = onPTTStop;
      mediaRecorder.start(250);
      console.log('[PTT] recording… mime=', mime);
    } catch (e) {
      console.error('[PTT] start error', e);
      setStatus('idle');
    }
  }

  async function stopPTT() {
    try {
      if (mediaRecorder?.state === 'recording') { mediaRecorder.requestData?.(); mediaRecorder.stop(); }
      mediaStream?.getTracks().forEach(t => t.stop());
    } catch {}
  }

  async function onPTTStop() {
    try {
      setStatus('transcribing');
      if (!chunks.length) { setStatus('idle'); return; }
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || mimePick() });
      if (blob.size < 2000) { transcriptEl && (transcriptEl.textContent = '(no speech)'); setStatus('idle'); return; }
      const ab = await blob.arrayBuffer();
      const dataUrl = `data:${blob.type || 'audio/webm'};base64,${toB64(ab)}`;

      const stt = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl, language: 'en' }),
      });
      const sttJson = await stt.json().catch(()=> ({}));
      console.log('[PTT] STT', stt.status, sttJson);
      const transcript = (sttJson?.transcript || '').trim();
      if (transcriptEl) transcriptEl.textContent = transcript || '(no speech)';
      if (!stt.ok || !transcript) { setStatus('idle'); return; }

      setStatus('thinking');
      const reply = await chatStream(transcript, getVoice());
      setStatus('speaking');
      await speakText(reply, getVoice());
      setStatus('idle');
    } catch (e) {
      console.error('[PTT] flow error', e);
      setStatus('idle');
    } finally {
      chunks = []; mediaRecorder = null; mediaStream = null;
    }
  }

  // ---------- Wire UI ----------
  sendBtn?.addEventListener('click', handleSend);
  speakBtn?.addEventListener('click', async () => {
    stopSpeaking();
    const text = replyEl?.textContent?.trim() || inputEl?.value?.trim();
    if (!text) return;
    setStatus('speaking'); await speakText(text, getVoice()); setStatus('idle');
  });
  if (pttBtn) {
    pttBtn.addEventListener('pointerdown', startPTT);
    pttBtn.addEventListener('pointerup', stopPTT);
    pttBtn.addEventListener('pointerleave', () => mediaRecorder?.state === 'recording' && stopPTT());
  }
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  // ---------- UX: show IDs in console & a tiny hint ----------
  setStatus('idle');
  console.log('[Keilani] chat.js ready (Edge streaming + voices + session)', { userId, sessionId, voice: getVoice() });

  // Optional: show IDs in UI if you have a status pill
  try {
    const hintId = 'whoamiHint';
    if (!document.getElementById(hintId)) {
      const hint = document.createElement('div');
      hint.id = hintId;
      hint.className = 'mono muted';
      hint.style.cssText = 'margin-top:8px;font-size:12px;opacity:.7;';
      hint.textContent = `userId=${userId}  sessionId=${sessionId}`;
      (document.querySelector('.wrap') || document.body).appendChild(hint);
    }
  } catch {}
})();
