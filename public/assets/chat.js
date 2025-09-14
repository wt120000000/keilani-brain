/* public/assets/chat.js
   Keilani Brain — Live (text + push-to-talk)
   - Text input -> chat-stream (SSE) -> ElevenLabs TTS
   - Push-to-talk (MediaRecorder) -> STT -> chat-stream -> TTS
   - Status badge + robust logs
*/

(() => {
  // ---- DOM ----
  const $ = (sel) => document.querySelector(sel);

  const inputEl     = $('#input')       || $('textarea');     // main text area
  const sendBtn     = $('#sendBtn')     || $('#send');        // "Send"
  const speakBtn    = $('#speakBtn')    || $('#speak');       // "Speak Reply"
  const pttBtn      = $('#ptt')         || $('#holdToTalk');  // "Hold to talk"
  const voiceSel    = $('#voice')       || $('#voiceSelect'); // <select>
  const statusBadge = $('#status')      || $('.status');      // small status chip
  const transcriptEl= $('#transcript');                       // optional place to show transcript
  const replyEl     = $('#reply');                            // optional place to show assistant reply

  // Single audio element for TTS playback
  const speaker = (() => {
    let el = $('#speaker');
    if (!el) {
      el = document.createElement('audio');
      el.id = 'speaker';
      el.preload = 'none';
      document.body.appendChild(el);
    }
    return el;
  })();

  // Unlock audio on first user gesture to avoid autoplay errors
  let audioUnlocked = false;
  const unlockAudioOnce = () => {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ac = new AC();
        if (ac.state === 'suspended') ac.resume();
      }
      speaker.muted = false;
      audioUnlocked = true;
    } catch (e) {}
  };
  document.addEventListener('pointerdown', unlockAudioOnce, { once: true });

  // ---- Status helper ----
  function setStatus(s) {
    if (statusBadge) statusBadge.textContent = s;
  }

  // ---- Small UI helpers ----
  function getSelectedVoice() {
    return voiceSel && voiceSel.value ? voiceSel.value : '(default)';
  }

  function appendTo(el, text) {
    if (!el) return;
    const div = document.createElement('div');
    div.textContent = text;
    el.appendChild(div);
  }

  // ---- TTS: call Netlify tts function and play ----
  async function speak(text, voice = getSelectedVoice()) {
    if (!text || !text.trim()) return;
    const resp = await fetch('/.netlify/functions/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!resp.ok) {
      console.error('[TTS] HTTP', resp.status);
      throw new Error('tts_failed');
    }
    const ab = await resp.arrayBuffer();
    const url = URL.createObjectURL(new Blob([ab], { type: 'audio/mpeg' }));
    speaker.src = url;
    try {
      await speaker.play();
    } catch (e) {
      console.warn('[TTS] autoplay blocked, waiting for gesture', e);
    }
  }

  // ---- SSE parser over fetch() POST (text/event-stream) ----
  async function chatStreamSSE(message, voice = getSelectedVoice()) {
    // POST to SSE endpoint (server should return text/event-stream)
    const resp = await fetch('/.netlify/functions/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice }),
    });
    if (!resp.ok || !resp.body) {
      console.error('[chat-stream] HTTP', resp.status);
      throw new Error('chat_stream_failed');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalText = '';

    // Stream loop
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse by lines for SSE
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);

        // Standard SSE lines: "data: {...}" or "data: text"
        if (!line) continue;
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            break;
          }
          try {
            // Prefer JSON payloads { delta, done, content, etc. }
            const obj = JSON.parse(data);
            const chunk = obj.delta || obj.content || obj.text || '';
            finalText += chunk;
            if (replyEl && chunk) appendTo(replyEl, chunk);
          } catch {
            // Fallback: treat as raw text
            finalText += data;
            if (replyEl && data) appendTo(replyEl, data);
          }
        }
      }
    }

    return finalText.trim();
  }

  // ---- Send a text message: UI -> chat -> TTS ----
  async function handleSend() {
    try {
      unlockAudioOnce();
      const userText = (inputEl?.value || '').trim();
      if (!userText) return;

      setStatus('thinking');
      console.log('[SEND] → chat-stream:', userText);

      // Clear streamed reply container if present
      if (replyEl) replyEl.textContent = '';

      const reply = await chatStreamSSE(userText, getSelectedVoice());
      console.log('[SEND] reply:', reply);

      setStatus('speaking');
      await speak(reply, getSelectedVoice());

      setStatus('idle');
    } catch (e) {
      console.error('[SEND] error', e);
      setStatus('idle');
    }
  }

  // ---- Speak the current reply (or the text box) again ----
  async function handleSpeak() {
    try {
      unlockAudioOnce();
      let text = '';
      if (replyEl && replyEl.textContent && replyEl.textContent.trim()) {
        text = replyEl.textContent.trim();
      } else if (inputEl && inputEl.value.trim()) {
        text = inputEl.value.trim();
      }
      if (!text) return;
      setStatus('speaking');
      await speak(text, getSelectedVoice());
      setStatus('idle');
    } catch (e) {
      console.error('[SPEAK] error', e);
      setStatus('idle');
    }
  }

  // ---- Push-to-talk (PTT): MediaRecorder -> STT -> chat -> TTS ----
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];

  function recorderMime() {
    // Pick best supported container
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/ogg'))  return 'audio/ogg';
    // Fallback — Whisper will sniff
    return 'audio/webm';
    // (Safari iOS records AAC in MP4 via WebM shim unpredictably; server sniff handles it)
  }

  async function startPTT() {
    try {
      unlockAudioOnce();
      setStatus('listening');
      chunks = [];
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = recorderMime();
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = onPTTStop;
      mediaRecorder.start();
      console.log('[PTT] recording… mime =', mime);
    } catch (e) {
      console.error('[PTT] getUserMedia error', e);
      setStatus('idle');
    }
  }

  async function stopPTT() {
    try {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
      }
    } catch (e) {
      console.warn('[PTT] stop error', e);
    }
  }

  function arrayToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function onPTTStop() {
    try {
      setStatus('transcribing');
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
      const mime = blob.type || 'audio/webm';
      const sizeKB = Math.round(blob.size / 1024);
      console.log('[PTT] blob', mime, sizeKB, 'KB');

      const ab = await blob.arrayBuffer();
      const dataUrl = `data:${mime};base64,${arrayToBase64(ab)}`;

      // Call STT
      const sttResp = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl, language: 'en', verbose: false }),
      });

      let sttJson = {};
      try { sttJson = await sttResp.json(); } catch {}
      console.log('[PTT] STT', sttResp.status, sttJson);

      if (!sttResp.ok) {
        setStatus('idle');
        return;
      }

      const transcript = (sttJson.transcript || '').trim();
      if (transcriptEl) {
        transcriptEl.textContent = transcript;
      }
      if (!transcript) {
        console.log('[PTT] Heard silence');
        setStatus('idle');
        return;
      }

      // Chain into chat + TTS
      setStatus('thinking');
      if (replyEl) replyEl.textContent = '';
      const reply = await chatStreamSSE(transcript, getSelectedVoice());
      console.log('[PTT] chat reply:', reply);

      setStatus('speaking');
      await speak(reply, getSelectedVoice());

      setStatus('idle');
    } catch (e) {
      console.error('[PTT] flow error', e);
      setStatus('idle');
    } finally {
      chunks = [];
      mediaRecorder = null;
      mediaStream = null;
    }
  }

  // ---- Wire up UI events ----
  if (sendBtn)  sendBtn.addEventListener('click', handleSend);
  if (speakBtn) speakBtn.addEventListener('click', handleSpeak);

  if (pttBtn) {
    pttBtn.addEventListener('pointerdown', startPTT);
    pttBtn.addEventListener('pointerup', stopPTT);
    pttBtn.addEventListener('pointerleave', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') stopPTT();
    });
  }

  // Enter to send (Shift+Enter for newline)
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
  }

  // Initial state
  setStatus('idle');
  console.log('[Keilani] chat.js loaded');
})();
