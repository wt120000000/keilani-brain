/* public/assets/chat.js
   Keilani Brain — Live (text + push-to-talk)
   - Matches index.html IDs
   - chat-stream (SSE) with automatic fallback to /api/chat JSON
   - Strong PTT debug + status chip
*/

(() => {
  const $ = (sel) => document.querySelector(sel);
  const setText = (el, t) => { if (el) el.textContent = t; };

  // ----- DOM -----
  const inputEl      = $('#textIn');
  const voiceSel     = $('#voicePick');
  const sendBtn      = $('#sendBtn');
  const speakBtn     = $('#speakBtn');
  const pttBtn       = $('#pttBtn');
  const statusBadge  = $('#statePill');
  const transcriptEl = $('#transcriptBox');
  const replyEl      = $('#reply');
  const speaker      = $('#ttsPlayer');

  // ----- Audio unlock -----
  let audioUnlocked = false;
  function unlockAudioOnce() {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ac = new AC();
        if (ac.state === 'suspended') ac.resume();
      }
      if (speaker) speaker.muted = false;
      audioUnlocked = true;
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudioOnce, { once: true });

  // ----- UI helpers -----
  function setStatus(s) { setText(statusBadge, s); }
  function getVoice() { return (voiceSel?.value || '').trim(); }
  function clear(el) { if (el) el.textContent = ''; }
  function append(el, text) {
    if (!el || !text) return;
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
  }

  // ----- TTS (optional) -----
  async function speak(text) {
    const voice = getVoice();
    if (!text || !text.trim() || !voice) return;
    const resp = await fetch('/.netlify/functions/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!resp.ok) { console.error('[TTS] HTTP', resp.status); return; }
    const ab = await resp.arrayBuffer();
    const url = URL.createObjectURL(new Blob([ab], { type: 'audio/mpeg' }));
    speaker.src = url;
    try { await speaker.play(); } catch (e) { console.warn('[TTS] autoplay blocked', e); }
  }

  // ----- chat: streaming (SSE) -----
  async function chatStreamSSE(message) {
    const voice = getVoice();
    const resp = await fetch('/.netlify/functions/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice }),
    });

    if (!resp.ok || !resp.body) {
      // Surface raw body for debugging
      let raw = '';
      try { raw = await resp.text(); } catch {}
      console.error('[chat-stream] HTTP', resp.status, 'raw=', raw?.slice(0, 300));
      throw new Error('chat_stream_failed');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalText = '';
    clear(replyEl);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const obj = JSON.parse(data);
          const chunk = obj.delta ?? obj.content ?? obj.text ?? '';
          if (chunk) { finalText += chunk; append(replyEl, chunk); }
        } catch {
          finalText += data; append(replyEl, data);
        }
      }
    }
    return finalText.trim();
  }

  // ----- chat: non-stream fallback -----
  async function chatOnce(message) {
    const voice = getVoice();
    const resp = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice }),
    });
    const raw = await resp.text().catch(() => '');
    if (!resp.ok) {
      console.error('[chat] HTTP', resp.status, 'raw=', raw?.slice(0, 300));
      throw new Error('chat_failed');
    }
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    const reply = (data.reply || data.message || data.text || '').trim();
    if (!reply) throw new Error('chat_empty');
    clear(replyEl);
    append(replyEl, reply);
    return reply;
  }

  // Wrapper: try SSE then fallback to JSON chat
  async function chatSmart(message) {
    try {
      return await chatStreamSSE(message);
    } catch (e) {
      console.warn('[chat] falling back to /chat:', e?.message || e);
      return await chatOnce(message);
    }
  }

  // ----- Text send -----
  async function handleSend() {
    try {
      unlockAudioOnce();
      const msg = (inputEl?.value || '').trim();
      if (!msg) return;
      setStatus('thinking');
      const reply = await chatSmart(msg);
      setStatus('speaking');
      await speak(reply);
      setStatus('idle');
    } catch (e) {
      console.error('[SEND] error', e);
      setStatus('idle');
    }
  }

  // ----- Speak again -----
  async function handleSpeak() {
    try {
      unlockAudioOnce();
      let text = replyEl?.textContent?.trim() || inputEl?.value?.trim() || '';
      if (!text) return;
      setStatus('speaking');
      await speak(text);
      setStatus('idle');
    } catch (e) {
      console.error('[SPEAK] error', e);
      setStatus('idle');
    }
  }

  // ----- PTT -----
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];

  function recorderMime() {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/ogg')) return 'audio/ogg';
    return 'audio/webm';
  }
  function arrayToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function startPTT() {
    try {
      unlockAudioOnce();
      setStatus('listening');
      chunks = [];

      const streamConstraints = {
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000
        }
      };
      mediaStream = await navigator.mediaDevices.getUserMedia(streamConstraints);

      const tracks = mediaStream.getAudioTracks();
      if (tracks[0]?.muted) console.warn('[PTT] input appears muted');

      const mime = recorderMime();
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          console.log('[PTT] chunk', Math.round(e.data.size / 1024), 'KB');
          chunks.push(e.data);
        }
      };
      mediaRecorder.onstop = onPTTStop;

      mediaRecorder.start(250);
      console.log('[PTT] recording… mime =', mime);
    } catch (e) {
      console.error('[PTT] getUserMedia error', e);
      setStatus('idle');
    }
  }

  async function stopPTT() {
    try {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.requestData?.();
        mediaRecorder.stop();
      }
      if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn('[PTT] stop error', e);
    }
  }

  async function onPTTStop() {
    try {
      setStatus('transcribing');

      if (!chunks.length) {
        console.warn('[PTT] no chunks captured');
        setText(transcriptEl, '(no audio captured)');
        setStatus('idle');
        return;
      }

      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || recorderMime() });
      const mimeRecorded = blob.type || 'application/octet-stream';
      const sizeKB = Math.round(blob.size / 1024);
      console.log('[PTT] final blob', mimeRecorded, sizeKB, 'KB');

      if (blob.size < 2000) {
        setText(transcriptEl, '(no speech)');
        setStatus('idle');
        return;
      }

      const mimeForHeader = (mimeRecorded.split(';')[0] || 'audio/webm'); // strip ";codecs=opus"
      const ab = await blob.arrayBuffer();
      const dataUrl = `data:${mimeForHeader};base64,${arrayToBase64(ab)}`;
      console.log('[PTT] dataUrl length =', dataUrl.length, 'mimeHeader =', mimeForHeader, 'blobKB =', sizeKB);

      // STT
      const sttResp = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: dataUrl, language: 'en' })
      });

      const sttRaw = await sttResp.text().catch(() => '');
      console.log('[PTT] STT HTTP', sttResp.status, 'raw=', sttRaw.slice(0, 200));
      let sttJson = {};
      try { sttJson = JSON.parse(sttRaw); } catch {}

      if (!sttResp.ok) { setStatus('idle'); return; }

      const transcript = (sttJson.transcript || '').trim();
      setText(transcriptEl, transcript || '(no speech)');
      if (!transcript) { setStatus('idle'); return; }

      // Chat + optional TTS (with fallback)
      setStatus('thinking');
      const reply = await chatSmart(transcript);
      console.log('[PTT] chat reply:', reply);

      setStatus('speaking');
      await speak(reply);
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

  // ----- Wire UI -----
  if (sendBtn)  sendBtn.addEventListener('click', handleSend);
  if (speakBtn) speakBtn.addEventListener('click', handleSpeak);

  if (pttBtn) {
    pttBtn.addEventListener('pointerdown', startPTT);
    pttBtn.addEventListener('pointerup', stopPTT);
    pttBtn.addEventListener('pointerleave', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') stopPTT();
    });
    // Mouse/touch fallbacks
    pttBtn.addEventListener('mousedown', startPTT);
    pttBtn.addEventListener('mouseup', stopPTT);
    pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startPTT(); }, { passive: false });
    pttBtn.addEventListener('touchend',   (e) => { e.preventDefault(); stopPTT();  }, { passive: false });
    console.log('[PTT] bound to #pttBtn');
  } else {
    console.warn('[PTT] #pttBtn not found — check index.html IDs');
  }

  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
  }

  setStatus('idle');
  console.log('[Keilani] chat.js ready (IDs wired to index.html)');
})();
