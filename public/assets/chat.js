/* public/assets/chat.js
   Keilani Brain — Live
   - Text chat (SSE)
   - Push-to-talk with VAD-lite + live mic meter
   - Streaming TTS via MediaSource (fallback to /tts)
   - Barge-in: Speak/PTT can interrupt TTS any time
*/

(() => {
  const $ = (s) => document.querySelector(s);

  // DOM
  const inputEl      = $('#textIn');
  const sendBtn      = $('#sendBtn');
  const speakBtn     = $('#speakBtn');
  const stopBtn      = $('#stopBtn');       // optional: <button id="stopBtn">Stop</button>
  const pttBtn       = $('#pttBtn');
  const voiceSel     = $('#voicePick');
  const transcriptEl = $('#transcriptBox');
  const replyEl      = $('#reply');
  const speaker      = $('#ttsPlayer');     // <audio id="ttsPlayer" controls preload="none">
  const micBar       = $('#micBar');        // meter fill
  const micDb        = $('#micDb');         // small dB label
  const vadSlider    = $('#vadThresh');     // sensitivity 1..12 (lower = more sensitive)

  // --- helpers
  const setTxt = (el, t) => { if (el) el.textContent = t; };
  const append = (el, t) => { if (el && t) el.textContent += t; };
  const clear  = (el) => { if (el) el.textContent = ''; };
  const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
  const getVoice = () => (voiceSel?.value || '');

  // --- audio unlock
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        if (ctx.state === 'suspended') ctx.resume();
      }
      if (speaker) speaker.muted = false;
      audioUnlocked = true;
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  // =========================
  //  T T S   (Streaming MSE)
  // =========================
  let ttsAbort = null;
  let mse = null, sourceBuffer = null, mseUrl = null, chunkQ = [];
  let audioEndedResolver = null;

  function resetMSE() {
    try { if (sourceBuffer && mse && mse.readyState === 'open') sourceBuffer.abort(); } catch {}
    try { if (mse && mse.readyState === 'open') mse.endOfStream(); } catch {}
    sourceBuffer = null; chunkQ = [];
    if (mseUrl) { URL.revokeObjectURL(mseUrl); mseUrl = null; }
    mse = null;
  }

  async function stopSpeaking() {
    try { if (ttsAbort) ttsAbort.abort(); } catch {}
    ttsAbort = null;
    try { speaker.pause(); } catch {}
    try { speaker.removeAttribute('src'); } catch {}
    resetMSE();
    if (audioEndedResolver) { audioEndedResolver(); audioEndedResolver = null; }
    $('#speakLed')?.remove();
    console.log('[TTS] stopSpeaking() – barge in');
  }

  // non-streaming fallback
  async function speakFallback(text, voice) {
    const resp = await fetch('/.netlify/functions/tts', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ text, voice })
    });
    if (!resp.ok) { console.error('[TTS] fallback HTTP', resp.status); return; }
    const ab = await resp.arrayBuffer();
    const url = URL.createObjectURL(new Blob([ab], { type:'audio/mpeg' }));
    speaker.src = url;
    try { await speaker.play(); } catch {}
    await new Promise(res => speaker.addEventListener('ended', res, { once:true }));
    URL.revokeObjectURL(url);
  }

  async function speakStream(text, voice) {
    if (!text || !voice) return;
    // toggle stop if already speaking
    if (!speaker.paused || ttsAbort) { await stopSpeaking(); return; }
    unlockAudio();

    // visual LED
    const led = document.createElement('span');
    led.id = 'speakLed';
    led.style.cssText = 'display:inline-block;width:10px;height:10px;margin-left:6px;border-radius:50%;background:#0f0;';
    speakBtn?.insertAdjacentElement('afterend', led);

    const canMSE = !!window.MediaSource && MediaSource.isTypeSupported('audio/mpeg');
    if (!canMSE) { await speakFallback(text, voice); return; }

    ttsAbort = new AbortController();
    const ctrl = ttsAbort;

    mse = new MediaSource();
    mseUrl = URL.createObjectURL(mse);
    speaker.src = mseUrl;

    const endedPromise = new Promise(res => { audioEndedResolver = res; });

    mse.addEventListener('sourceopen', async () => {
      try { sourceBuffer = mse.addSourceBuffer('audio/mpeg'); }
      catch (e) { console.warn('[MSE] addSourceBuffer failed, fallback', e); resetMSE(); await speakFallback(text, voice); return; }

      sourceBuffer.addEventListener('updateend', () => {
        if (!sourceBuffer || !chunkQ.length || sourceBuffer.updating) return;
        const chunk = chunkQ.shift();
        try { sourceBuffer.appendBuffer(chunk); } catch { /* queue if busy */ }
      });

      // Fetch streaming MP3 from our function
      let resp;
      try {
        resp = await fetch('/.netlify/functions/tts-stream', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ text, voice, latency: 3, format: 'mp3_44100_128' }),
          signal: ctrl.signal
        });
      } catch (e) {
        if (e?.name !== 'AbortError') console.warn('[tts-stream] fetch err', e);
        resetMSE(); return;
      }

      if (!resp.ok || !resp.body) {
        let raw=''; try { raw = await resp.text(); } catch {}
        console.error('[tts-stream] HTTP', resp.status, raw.slice(0,200));
        resetMSE(); await speakFallback(text, voice);
        return;
      }

      const reader = resp.body.getReader();
      speaker.play().catch(()=>{ /* wait for user gesture */ });

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || !value.byteLength) continue;
        const chunk = value.buffer ? new Uint8Array(value) : new Uint8Array(value);
        if (sourceBuffer) {
          if (!sourceBuffer.updating && chunkQ.length === 0) {
            try { sourceBuffer.appendBuffer(chunk); } catch { chunkQ.push(chunk); }
          } else {
            chunkQ.push(chunk);
          }
        }
      }

      // finalize
      const end = () => { try { if (mse && mse.readyState === 'open') mse.endOfStream(); } catch {} };
      if (!sourceBuffer || !mse) end();
      else if (!sourceBuffer.updating && chunkQ.length === 0) end();
      else {
        const flush = () => {
          sourceBuffer.removeEventListener('updateend', flush);
          if (!chunkQ.length && !sourceBuffer.updating) end();
        };
        sourceBuffer.addEventListener('updateend', flush);
      }
    });

    try { await speaker.play(); } catch {}
    await endedPromise;
    resetMSE();
    ttsAbort = null;
    $('#speakLed')?.remove();
  }

  // =========================
  //  C H A T   (SSE)
  // =========================
  async function chatStream(message, voice) {
    const msg = (message || '').trim();
    if (!msg) throw new Error('missing_text');
    clear(replyEl);

    const resp = await fetch('/.netlify/functions/chat-stream', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ message: msg, voice })
    });
    if (!resp.ok || !resp.body) throw new Error('chat_stream_failed');

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buffer = '', final = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream:true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx+1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const obj = JSON.parse(data);
          const delta = obj.delta ?? obj.content ?? obj.text ?? '';
          if (delta) { final += delta; append(replyEl, delta); }
        } catch { final += data; append(replyEl, data); }
      }
    }
    return final.trim();
  }

  // =========================
  //  S T T   (PTT + VAD)
  // =========================
  let mediaStream, mediaRecorder, chunks = [];
  let vadActive = false, silenceTimer = null;

  function arrayToBase64(buf) {
    let bin = '', bytes = new Uint8Array(buf);
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function recorderMime() {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/ogg')) return 'audio/ogg';
    return 'audio/webm';
  }
  function updateMeter(pct, db) {
    if (micBar) micBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (micDb)  micDb.textContent  = `${db.toFixed(1)} dB`;
  }

  async function startPTT() {
    // barge-in first, then record immediately
    await stopSpeaking();

    chunks = [];
    const mime = recorderMime();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
    console.log('[PTT] recording… mime=', mime);

    // VAD + meter
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = AC ? new AC() : null;
    if (ctx) {
      const src = ctx.createMediaStreamSource(mediaStream);
      const analyser = ctx.createAnalyser();
      src.connect(analyser);
      analyser.fftSize = 512;
      const data = new Uint8Array(analyser.fftSize);

      const thresh = () => {
        const v = Number(vadSlider?.value || 4);            // 1..12
        return 0.8 + (v-1) * ((2.5-0.8)/11);                // amplitude threshold
      };

      vadActive = true;
      (function loop() {
        if (!vadActive) return;
        analyser.getByteTimeDomainData(data);
        let peak = 0, sum = 0;
        for (let i=0;i<data.length;i++) {
          const d = Math.abs(data[i]-128);
          if (d > peak) peak = d;
          sum += d*d;
        }
        const rms = Math.sqrt(sum / data.length);           // ~0..128
        const db  = 20 * Math.log10((rms||1)/64);
        const pct = Math.min(100, (peak/64)*100);
        updateMeter(pct, db);

        if (rms < thresh()) {
          if (!silenceTimer) silenceTimer = setTimeout(stopPTT, 1100);
        } else {
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        }
        requestAnimationFrame(loop);
      })();
    }

    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = onPTTStop;
    mediaRecorder.start(250);
  }

  async function stopPTT() {
    vadActive = false;
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    updateMeter(0,0);
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  }

  async function onPTTStop() {
    if (!chunks.length) { setTxt(transcriptEl,'(no audio captured)'); return; }
    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
    const ab   = await blob.arrayBuffer();
    const baseMime = (blob.type || 'audio/webm').split(';')[0];
    const dataUrl  = `data:${baseMime};base64,${arrayToBase64(ab)}`;

    const resp = await fetch('/.netlify/functions/stt', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ audioBase64: dataUrl, language:'en' })
    });
    const raw = await resp.text().catch(()=> ''); let json={}; try{ json=JSON.parse(raw);}catch{}
    console.log('[PTT] STT', resp.status, json);

    if (!resp.ok) { setTxt(transcriptEl,'(stt error)'); return; }
    const transcript = (json.transcript || '').trim();
    setTxt(transcriptEl, transcript || '(no speech)');
    if (!transcript) return;

    const reply = await chatStream(transcript, getVoice());
    // Use streaming TTS first; fall back if no voice or error
    if (getVoice()) {
      try { await speakStream(reply, getVoice()); }
      catch { await speakFallback(reply, getVoice()); }
    }
  }

  // =========================
  //  H A N D L E R S
  // =========================
  async function handleSend() {
    await stopSpeaking();
    const text = inputEl.value.trim();
    if (!text) return;
    const reply = await chatStream(text, getVoice());
    if (getVoice()) {
      try { await speakStream(reply, getVoice()); }
      catch { await speakFallback(reply, getVoice()); }
    }
  }

  async function handleSpeak() {
    const text = (replyEl?.textContent?.trim() || inputEl?.value?.trim() || '');
    if (!text) return;
    if (!getVoice()) return;
    await speakStream(text, getVoice()); // toggles stop if already speaking
  }

  // =========================
  //  W I R E   U I
  // =========================
  sendBtn?.addEventListener('click', handleSend);
  speakBtn?.addEventListener('click', handleSpeak);
  stopBtn?.addEventListener('click', stopSpeaking);

  pttBtn?.addEventListener('pointerdown', startPTT);
  pttBtn?.addEventListener('pointerup', stopPTT);
  pttBtn?.addEventListener('pointerleave', stopPTT);

  // keyboard: Space = PTT, S = stop TTS, Enter = send
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) { e.preventDefault(); startPTT(); }
    if (e.key?.toLowerCase() === 's')   { e.preventDefault(); stopSpeaking(); }
    if (e.key === 'Enter' && e.target === inputEl && !e.shiftKey) {
      e.preventDefault(); handleSend();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { e.preventDefault(); stopPTT(); }
  });

  console.log('[Keilani] chat.js ready (streaming TTS)');
})();
