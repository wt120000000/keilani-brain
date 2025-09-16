/* public/assets/chat.js
   Keilani Brain — Live (text + push-to-talk + barge-in + VAD-lite)
*/

(() => {
  const $ = (sel) => document.querySelector(sel);

  const inputEl      = $('#textIn');
  const sendBtn      = $('#sendBtn');
  const speakBtn     = $('#speakBtn');
  const stopBtn      = $('#stopBtn'); // NEW
  const pttBtn       = $('#pttBtn');
  const voiceSel     = $('#voicePick');
  const transcriptEl = $('#transcriptBox');
  const replyEl      = $('#reply');
  const ttsPlayer    = $('#ttsPlayer');

  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        if (ctx.state === 'suspended') ctx.resume();
      }
      ttsPlayer.muted = false;
      audioUnlocked = true;
    } catch (e) {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  function getVoice() {
    return voiceSel?.value || '';
  }

  function setTranscript(t) {
    if (transcriptEl) transcriptEl.textContent = t || '(no speech)';
  }
  function appendReply(txt) {
    if (!replyEl) return;
    replyEl.textContent += txt;
  }
  function clearReply() {
    if (replyEl) replyEl.textContent = '';
  }

  // ------------------ TTS (with barge-in) ------------------
  let ac, source, analyser, rafId;

  function stopSpeaking() {
    if (ttsPlayer) {
      ttsPlayer.pause();
      ttsPlayer.removeAttribute('src');
      ttsPlayer.load();
    }
    if (rafId) cancelAnimationFrame(rafId);
    if (source) source.disconnect();
    if (analyser) analyser.disconnect();
    console.log('[TTS] stopSpeaking() – barge in');
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
    const ab = await resp.arrayBuffer();
    const url = URL.createObjectURL(new Blob([ab], { type: 'audio/mpeg' }));
    ttsPlayer.src = url;

    // Visual LED
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    source = ac.createMediaElementSource(ttsPlayer);
    analyser = ac.createAnalyser();
    source.connect(analyser);
    analyser.connect(ac.destination);
    analyser.fftSize = 256;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const led = document.createElement('span');
    led.id = 'speakLed';
    led.style.cssText =
      'display:inline-block;width:10px;height:10px;margin-left:6px;border-radius:50%;background:#0f0;';
    speakBtn.insertAdjacentElement('afterend', led);

    function draw() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      led.style.opacity = avg > 10 ? '1' : '0.3';
      rafId = requestAnimationFrame(draw);
    }
    draw();

    ttsPlayer.onended = () => {
      stopSpeaking();
      const ledEl = $('#speakLed');
      if (ledEl) ledEl.remove();
    };

    try {
      await ttsPlayer.play();
    } catch (e) {
      console.warn('[TTS] autoplay blocked');
    }
  }

  // ------------------ Chat-stream (SSE) ------------------
  async function chatStream(msg, voice) {
    clearReply();
    const resp = await fetch('/.netlify/functions/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, voice }),
    });
    if (!resp.ok || !resp.body) throw new Error('chat-stream failed');

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    let finalText = '';

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
          if (delta) {
            finalText += delta;
            appendReply(delta);
          }
        } catch {}
      }
    }
    return finalText.trim();
  }

  // ------------------ STT (Push-to-talk + VAD-lite) ------------------
  let mediaStream, mediaRecorder, chunks = [], silenceTimer, vadActive = false;

  function arrayToBase64(buf) {
    let bin = '', bytes = new Uint8Array(buf);
    for (let b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  async function startPTT() {
    stopSpeaking(); // barge-in
    chunks = [];
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType: 'audio/webm;codecs=opus'
    });

    // VAD-lite
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(mediaStream);
    const analyser = ctx.createAnalyser();
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    function checkSilence() {
      analyser.getByteTimeDomainData(data);
      const avg = data.reduce((a, b) => a + Math.abs(b - 128), 0) / data.length;
      if (avg < 2) {
        if (!silenceTimer) silenceTimer = setTimeout(stopPTT, 1200);
      } else {
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
      }
      if (vadActive) requestAnimationFrame(checkSilence);
    }

    mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = onPTTStop;
    mediaRecorder.start(250);

    vadActive = true;
    checkSilence();

    console.log('[PTT] recording…');
  }

  async function stopPTT() {
    vadActive = false;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
  }

  async function onPTTStop() {
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: 'audio/webm;codecs=opus' });
    const ab = await blob.arrayBuffer();
    const b64 = arrayToBase64(ab);
    const dataUrl = `data:${blob.type};base64,${b64}`;

    const resp = await fetch('/.netlify/functions/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: dataUrl, language: 'en' }),
    });
    const json = await resp.json();
    console.log('[PTT] STT', resp.status, json);
    const transcript = json.transcript || '';
    setTranscript(transcript);

    if (!transcript) return;
    const reply = await chatStream(transcript, getVoice());
    await speak(reply, getVoice());
  }

  // ------------------ Handlers ------------------
  async function handleSend() {
    stopSpeaking();
    const text = inputEl.value.trim();
    if (!text) return;
    const reply = await chatStream(text, getVoice());
    await speak(reply, getVoice());
  }

  async function handleSpeak() {
    stopSpeaking();
    let text = replyEl.textContent.trim() || inputEl.value.trim();
    if (text) await speak(text, getVoice());
  }

  // ------------------ UI bindings ------------------
  sendBtn?.addEventListener('click', handleSend);
  speakBtn?.addEventListener('click', handleSpeak);
  stopBtn?.addEventListener('click', stopSpeaking);

  pttBtn?.addEventListener('pointerdown', startPTT);
  pttBtn?.addEventListener('pointerup', stopPTT);

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.code === 'Space' && !e.repeat) startPTT();
    if (e.code === 'Space' && e.type === 'keyup') stopPTT();
    if (e.key.toLowerCase() === 's') stopSpeaking();
  });

  console.log('[Keilani] chat.js ready');
})();
