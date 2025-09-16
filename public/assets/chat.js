/* public/assets/chat.js
   Keilani Brain — Live (PTT + VAD + barge-in) with mic meter & sensitivity
*/

(() => {
  const $ = (sel) => document.querySelector(sel);

  // DOM
  const inputEl      = $('#textIn');
  const sendBtn      = $('#sendBtn');
  const speakBtn     = $('#speakBtn');
  const stopBtn      = $('#stopBtn');          // optional Stop button
  const pttBtn       = $('#pttBtn');
  const voiceSel     = $('#voicePick');
  const transcriptEl = $('#transcriptBox');
  const replyEl      = $('#reply');
  const ttsPlayer    = $('#ttsPlayer');

  // NEW: meter UI
  const micBar       = $('#micBar');
  const micDb        = $('#micDb');
  const vadSlider    = $('#vadThresh');        // 1 (very sensitive) .. 12 (less sensitive)

  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        if (ctx.state === 'suspended') ctx.resume();
      }
      if (ttsPlayer) ttsPlayer.muted = false;
      audioUnlocked = true;
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  const getVoice = () => (voiceSel?.value || '');
  const setTranscript = (t) => { if (transcriptEl) transcriptEl.textContent = t || '(no speech)'; };
  const appendReply   = (txt) => { if (replyEl) replyEl.textContent += txt; };
  const clearReply    = () => { if (replyEl) replyEl.textContent = ''; };

  // ---------- TTS (simple) + barge-in ----------
  let ac, source, analyser, rafId;
  function stopSpeaking() {
    try { ttsPlayer.pause(); } catch {}
    try { ttsPlayer.removeAttribute('src'); ttsPlayer.load(); } catch {}
    if (rafId) cancelAnimationFrame(rafId);
    if (source) try { source.disconnect(); } catch {}
    if (analyser) try { analyser.disconnect(); } catch {}
    console.log('[TTS] stopSpeaking() – barge in');
    $('#speakLed')?.remove();
  }

  async function speak(text, voice) {
    stopSpeaking();
    if (!text) return;
    unlockAudio();

    const resp = await fetch('/.netlify/functions/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!resp.ok) throw new Error('TTS failed');

    const ab  = await resp.arrayBuffer();
    const url = URL.createObjectURL(new Blob([ab], { type: 'audio/mpeg' }));
    ttsPlayer.src = url;

    // LED
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ac && AC) ac = new AC();
    if (ac) {
      source   = ac.createMediaElementSource(ttsPlayer);
      analyser = ac.createAnalyser();
      source.connect(analyser);
      analyser.connect(ac.destination);
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);

      const led = document.createElement('span');
      led.id = 'speakLed';
      led.style.cssText = 'display:inline-block;width:10px;height:10px;margin-left:6px;border-radius:50%;background:#0f0;';
      speakBtn?.insertAdjacentElement('afterend', led);

      const draw = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a,b)=>a+b,0)/data.length;
        led.style.opacity = avg > 10 ? '1' : '0.3';
        rafId = requestAnimationFrame(draw);
      };
      draw();

      ttsPlayer.onended = () => { stopSpeaking(); };
    }

    try { await ttsPlayer.play(); } catch { console.warn('[TTS] autoplay blocked'); }
  }

  // ---------- chat-stream (SSE) ----------
  async function chatStream(msg, voice) {
    const text = (msg || '').trim();
    if (!text) throw new Error('missing_text');
    clearReply();

    const resp = await fetch('/.netlify/functions/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, voice }),
    });
    if (!resp.ok || !resp.body) throw new Error('chat-stream failed');

    const reader = resp.body.getReader();
    const dec    = new TextDecoder();
    let buffer   = '';
    let final    = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        try {
          const obj = JSON.parse(data);
          const delta = obj.delta || obj.content || obj.text || '';
          if (delta) { final += delta; appendReply(delta); }
        } catch {}
      }
    }
    return final.trim();
  }

  // ---------- STT (PTT + VAD + meter) ----------
  let mediaStream, mediaRecorder, chunks = [], silenceTimer, vadActive = false;

  const arrayToBase64 = (buf) => {
    let bin = '', bytes = new Uint8Array(buf);
    for (let b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
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
    // barge-in
    stopSpeaking();

    chunks = [];
    const mime = recorderMime();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
    console.log('[PTT] recording… mime=', mime);

    // VAD + meter
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = AC ? new AC() : null;
    let analyser, data;
    if (ctx) {
      const src = ctx.createMediaStreamSource(mediaStream);
      analyser  = ctx.createAnalyser();
      src.connect(analyser);
      analyser.fftSize = 512;
      data = new Uint8Array(analyser.fftSize);

      // thresh knob: lower = more sensitive
      const getThresh = () => {
        const v = Number(vadSlider?.value || 4); // 1..12
        // map 1..12  -> amplitude 0.8..2.5
        return 0.8 + (v-1) * ((2.5-0.8)/11);
      };

      vadActive = true;
      (function loop() {
        if (!vadActive || !analyser) return;

        analyser.getByteTimeDomainData(data);
        // center around 128, compute peak & RMS-ish value
        let peak = 0, sum = 0;
        for (let i=0;i<data.length;i++) {
          const v = Math.abs(data[i]-128);
          if (v > peak) peak = v;
          sum += v*v;
        }
        const rms = Math.sqrt(sum / data.length);     // ~0..128
        const db  = 20 * Math.log10((rms || 1)/64);   // crude display
        const pct = Math.min(100, (peak/64)*100);
        updateMeter(pct, db);

        const thr = getThresh();
        if (rms < thr) {
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
    updateMeter(0, 0);
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  }

  async function onPTTStop() {
    if (!chunks.length) { setTranscript('(no audio captured)'); return; }
    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
    const ab   = await blob.arrayBuffer();
    const b64  = arrayToBase64(ab);

    const baseMime = (blob.type || 'audio/webm').split(';')[0];
    const dataUrl  = `data:${baseMime};base64,${b64}`;

    const resp = await fetch('/.netlify/functions/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: dataUrl, language: 'en' }),
    });

    const raw = await resp.text().catch(()=> '');
    let json  = {}; try { json = JSON.parse(raw); } catch {}
    console.log('[PTT] STT', resp.status, json);

    if (!resp.ok) {
      const msg = json?.detail?.error?.message || raw || `HTTP ${resp.status}`;
      setTranscript('(stt error)');
      console.warn('[PTT] STT error:', msg);
      return;
    }

    const transcript = (json.transcript || '').trim();
    setTranscript(transcript);
    if (!transcript) return;

    const reply = await chatStream(transcript, getVoice());
    await speak(reply, getVoice());
  }

  // ---------- handlers ----------
  async function handleSend() {
    stopSpeaking();
    const text = inputEl.value.trim();
    if (!text) return;
    const reply = await chatStream(text, getVoice());
    await speak(reply, getVoice());
  }
  async function handleSpeak() {
    stopSpeaking();
    const text = (replyEl.textContent?.trim() || inputEl.value.trim());
    if (text) await speak(text, getVoice());
  }

  // UI bindings
  sendBtn?.addEventListener('click', handleSend);
  speakBtn?.addEventListener('click', handleSpeak);
  stopBtn?.addEventListener('click', stopSpeaking);

  pttBtn?.addEventListener('pointerdown', startPTT);
  pttBtn?.addEventListener('pointerup', stopPTT);
  pttBtn?.addEventListener('pointerleave', stopPTT);

  // keyboard: Space = PTT, S = stop TTS, Enter = send
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) { e.preventDefault(); startPTT(); }
    if (e.key.toLowerCase() === 's')    { e.preventDefault(); stopSpeaking(); }
    if (e.key === 'Enter' && e.target === inputEl && !e.shiftKey) {
      e.preventDefault(); handleSend();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { e.preventDefault(); stopPTT(); }
  });

  console.log('[Keilani] chat.js ready');
})();
