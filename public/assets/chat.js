/* public/assets/chat.js
   Keilani Brain — Live (text + push-to-talk)
   - Text input -> chat-stream (SSE) -> TTS (ElevenLabs)
   - Push-to-talk -> MediaRecorder -> STT -> chat-stream -> TTS
   - Auto-binds PTT even if the button is injected later (MutationObserver)
   - Robust debug logs
*/

(() => {
  // ---------- DOM READY ----------
  const onReady = (fn) => {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      queueMicrotask(fn);
    } else {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    }
  };

  onReady(init);

  function init() {
    const $ = (sel) => document.querySelector(sel);

    // ---------- Elements (some may be missing; we’ll cope) ----------
    const inputEl      = $('#input')        || $('textarea');
    const sendBtn      = $('#sendBtn')      || $('#send');
    const speakBtn     = $('#speakBtn')     || $('#speak');
    const voiceSel     = $('#voice')        || $('#voiceSelect');
    const statusBadge  = $('#status')       || $('.status');
    const transcriptEl = $('#transcript');
    const replyEl      = $('#reply');

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

    // ---------- Audio unlock ----------
    let audioUnlocked = false;
    function unlockAudioOnce() {
      if (audioUnlocked) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const ac = new AC();
          if (ac.state === 'suspended') ac.resume();
        }
        speaker.muted = false;
        audioUnlocked = true;
      } catch {}
    }
    document.addEventListener('pointerdown', unlockAudioOnce, { once: true });

    // ---------- UI helpers ----------
    function setStatus(s) { if (statusBadge) statusBadge.textContent = s; }
    function getSelectedVoice() { return voiceSel && voiceSel.value ? voiceSel.value : '(default)'; }
    function clearNode(el) { if (el) el.textContent = ''; }
    function appendText(el, text) {
      if (!el || !text) return;
      const span = document.createElement('span');
      span.textContent = text;
      el.appendChild(span);
    }

    // ---------- TTS ----------
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
      try { await speaker.play(); } catch (e) { console.warn('[TTS] autoplay blocked', e); }
    }

    // ---------- chat-stream (SSE over fetch) ----------
    async function chatStreamSSE(message, voice = getSelectedVoice()) {
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
      clearNode(replyEl);

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // parse SSE (line-delimited)
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
            if (chunk) { finalText += chunk; appendText(replyEl, chunk); }
          } catch {
            finalText += data;
            appendText(replyEl, data);
          }
        }
      }
      return finalText.trim();
    }

    // ---------- Text Send ----------
    async function handleSend() {
      try {
        unlockAudioOnce();
        const userText = (inputEl?.value || '').trim();
        if (!userText) return;

        setStatus('thinking');
        console.log('[SEND] → chat-stream:', userText);

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

    // ---------- Speak current reply / input ----------
    async function handleSpeak() {
      try {
        unlockAudioOnce();
        let text = '';
        if (replyEl && replyEl.textContent?.trim()) text = replyEl.textContent.trim();
        else if (inputEl && inputEl.value?.trim()) text = inputEl.value.trim();
        if (!text) return;
        setStatus('speaking');
        await speak(text, getSelectedVoice());
        setStatus('idle');
      } catch (e) {
        console.error('[SPEAK] error', e);
        setStatus('idle');
      }
    }

    // ---------- Push-to-talk (PTT) ----------
    let mediaStream = null;
    let mediaRecorder = null;
    let chunks = [];

    function recorderMime() {
      // Prefer WebM/Opus; fall back sanely
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

        // Debug-friendly constraints: avoid OS processing that can zero-out short clips
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

        // Ensure periodic chunking across browsers
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
          mediaRecorder.requestData?.(); // flush final chunk
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
          if (transcriptEl) transcriptEl.textContent = '(no audio captured)';
          setStatus('idle');
          return;
        }

        const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || recorderMime() });
        const mime = blob.type || 'application/octet-stream';
        const sizeKB = Math.round(blob.size / 1024);
        console.log('[PTT] final blob', mime, sizeKB, 'KB');

        if (blob.size < 2000) {
          if (transcriptEl) transcriptEl.textContent = '(no speech)';
          console.log('[PTT] blob too small for STT (', blob.size, 'bytes )');
          setStatus('idle');
          return;
        }

        const ab = await blob.arrayBuffer();
        const dataUrl = `data:${mime};base64,${arrayToBase64(ab)}`;
        console.log('[PTT] dataUrl length =', dataUrl.length, 'mime =', mime, 'blobKB =', sizeKB);

        // ---- STT
        const sttResp = await fetch('/.netlify/functions/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: dataUrl, language: 'en' }) // no verbose
        });

        let sttText = '';
        try { sttText = await sttResp.text(); } catch {}
        console.log('[PTT] STT HTTP', sttResp.status, 'raw=', sttText?.slice(0, 200));

        let sttJson = {};
        try { sttJson = JSON.parse(sttText); } catch { sttJson = {}; }

        if (!sttResp.ok) { setStatus('idle'); return; }

        const transcript = (sttJson.transcript || '').trim();
        if (transcriptEl) transcriptEl.textContent = transcript || '(no speech)';
        if (!transcript) { setStatus('idle'); return; }

        // ---- Chat + TTS
        setStatus('thinking');
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

    // ---------- PTT BINDING (resilient) ----------
    const PTT_SELECTORS = [
      '#ptt', '#holdToTalk', '#mic', '#micBtn', '#pushToTalk', '#talk',
      '[data-ptt]', '[data-role="ptt"]', '.ptt', '.hold-to-talk', '.mic'
    ];

    function findPTTButton() {
      for (const sel of PTT_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    function bindPTTButton(btn) {
      // Clean any previous listeners by cloning
      const fresh = btn.cloneNode(true);
      btn.replaceWith(fresh);

      // Pointer events
      fresh.addEventListener('pointerdown', startPTT);
      fresh.addEventListener('pointerup', stopPTT);
      fresh.addEventListener('pointerleave', () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') stopPTT();
      });
      // Mouse/touch fallbacks
      fresh.addEventListener('mousedown', startPTT);
      fresh.addEventListener('mouseup', stopPTT);
      fresh.addEventListener('touchstart', (e) => { e.preventDefault(); startPTT(); }, { passive: false });
      fresh.addEventListener('touchend',   (e) => { e.preventDefault(); stopPTT();  }, { passive: false });

      console.log('[PTT] bound to', fresh.id ? `#${fresh.id}` : fresh.className || '<element>');
      return fresh;
    }

    // Try immediate bind
    let pttBtn = findPTTButton();
    if (pttBtn) {
      pttBtn = bindPTTButton(pttBtn);
    } else {
      console.warn('[PTT] button not found at init, watching DOM…');
      // Watch for dynamic insertion
      const mo = new MutationObserver(() => {
        const found = findPTTButton();
        if (found) {
          pttBtn = bindPTTButton(found);
          mo.disconnect();
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ---------- Other UI wiring ----------
    if (sendBtn)  sendBtn.addEventListener('click', handleSend);
    if (speakBtn) speakBtn.addEventListener('click', handleSpeak);
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
    }

    // ---------- Init ----------
    setStatus('idle');
    console.log('[Keilani] chat.js ready');
  }
})();
