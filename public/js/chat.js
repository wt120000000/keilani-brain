/* Keilani Chat — client with robust voice playback
   - Voice modes: Off | Local Voice | D-ID Avatar
   - SSE and non-SSE supported
*/

(() => {
  // ---------- UI WIRING ----------
  const ui = {
    feed: document.querySelector('[data-feed]') || document.getElementById('feed') || document.querySelector('.feed'),
    form: document.getElementById('form') || document.querySelector('form[data-chat]') || document.querySelector('form'),
    input: document.getElementById('input') || document.querySelector('textarea, input[type="text"]'),
    sendBtn: document.getElementById('send') || document.querySelector('[data-send]'),
    model: document.getElementById('model') || document.querySelector('#model, select[name="model"]'),
    api: document.getElementById('api') || document.querySelector('#api, input[name="api"]'),
    token: document.getElementById('token') || document.querySelector('#token, input[name="token"]'),
    stream: document.getElementById('stream') || document.querySelector('#stream, input[name="stream"]'),
    sse: document.getElementById('sse') || document.querySelector('#sse, input[name="sse"]'),
    voice: document.getElementById('voice') || document.querySelector('#voice, select[name="voice"]')
  };

  const need = (name, el) => { if (!el) throw new Error(`Missing UI node: ${name}`); };
  need('feed', ui.feed);
  need('form', ui.form);
  need('input', ui.input);
  need('sendBtn', ui.sendBtn);
  need('model', ui.model);
  need('api', ui.api);
  need('token', ui.token);
  need('stream', ui.stream);
  need('sse', ui.sse);
  need('voice', ui.voice);

  // Media elements (we’ll choose audio OR video at runtime)
  let audioEl = document.getElementById('voice-audio');
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = 'voice-audio';
    audioEl.preload = 'auto';
    audioEl.playsInline = true;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
  }
  let videoEl = document.getElementById('voice-video');
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.id = 'voice-video';
    videoEl.preload = 'auto';
    videoEl.playsInline = true;
    videoEl.muted = false;
    videoEl.style.display = 'none';
    document.body.appendChild(videoEl);
  }

  console.log('[chat.js] UI found:', {
    feed: !!ui.feed, input: !!ui.input, form: !!ui.form, sendBtn: !!ui.sendBtn,
    model: !!ui.model, api: !!ui.api, token: !!ui.token, stream: !!ui.stream,
    sse: !!ui.sse, voice: !!ui.voice
  });

  // ---------- AUTOPLAY UNLOCK ----------
  const unlockMedia = async () => {
    try {
      audioEl.volume = 1;
      audioEl.muted = false;
      await audioEl.play().catch(() => {});
      audioEl.pause();
      audioEl.currentTime = 0;

      videoEl.volume = 1;
      videoEl.muted = false;
      await videoEl.play().catch(() => {});
      videoEl.pause();
      videoEl.currentTime = 0;

      console.log('[chat.js] Media unlocked');
    } catch {}
    window.removeEventListener('click', unlockMedia, true);
    window.removeEventListener('touchstart', unlockMedia, true);
  };
  window.addEventListener('click', unlockMedia, true);
  window.addEventListener('touchstart', unlockMedia, true);

  // ---------- RENDER HELPERS ----------
  function now() {
    const d = new Date();
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }

  function bubble(role, text, opts = {}) {
    const node = document.createElement('div');
    node.className = `msg msg-${role}`;
    node.setAttribute('data-role', role);
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text || '';
    node.appendChild(body);

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = `${role === 'user' ? 'You' : 'Keilani'} ${now()}`;
    node.appendChild(meta);

    if (opts.muted) node.classList.add('muted');
    if (opts.id) node.id = opts.id;

    ui.feed.appendChild(node);
    ui.feed.scrollTop = ui.feed.scrollHeight;
    return body;
  }

  function appendChunk(bodyNode, text) {
    if (!text) return;
    bodyNode.textContent += text;
    ui.feed.scrollTop = ui.feed.scrollHeight;
  }

  // ---------- CHAT SEND ----------
  async function send(message) {
    const apiURL = (ui.api.value || '/api/chat').trim();
    const expectSSE = !!ui.sse.checked;
    const doStream = !!ui.stream.checked;
    const theModel = (ui.model.value || 'gpt-5').trim();
    const clientToken = (ui.token.value || '').trim();
    const voiceMode = (ui.voice.value || 'Off').trim(); // Off | Local Voice | D-ID Avatar

    bubble('user', message);
    const assistantBody = bubble('assistant', '', { muted: doStream });

    const payload = {
      model: theModel,
      messages: [{ role: 'user', content: message }],
      stream: doStream,
      expectSSE
    };
    if (clientToken) payload.client_token = clientToken;

    const headers = { 'Content-Type': 'application/json' };
    let resp;
    try {
      resp = await fetch(apiURL, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (err) {
      appendChunk(assistantBody, `\n[Error: failed to connect: ${err.message}]`);
      return;
    }

    if (expectSSE) {
      const finalText = await handleSSE(resp, assistantBody);
      await maybeSpeak(finalText, voiceMode);
    } else {
      const finalText = await handleJSON(resp, assistantBody);
      await maybeSpeak(finalText, voiceMode);
    }
  }

  // ---------- STREAM (SSE) ----------
  async function handleSSE(response, assistantBody) {
    if (!response.ok || !response.body) {
      appendChunk(assistantBody, `\n[Error: HTTP ${response.status}]`);
      return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let finalText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();

      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        const data = part.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content || '';
          if (delta) {
            finalText += delta;
            appendChunk(assistantBody, delta);
          }
        } catch {
          appendChunk(assistantBody, data);
        }
      }
    }

    assistantBody.parentElement.classList.remove('muted');
    return finalText.trim();
  }

  // ---------- NON-STREAM (JSON) ----------
  async function handleJSON(response, assistantBody) {
    let text = '';
    try {
      if (!response.ok) {
        appendChunk(assistantBody, `\n[Error: HTTP ${response.status}]`);
        return '';
      }
      const json = await response.json();
      text =
        json?.choices?.[0]?.message?.content ??
        json?.message?.content ??
        json?.content ??
        (typeof json === 'string' ? json : '');

      if (!text) text = JSON.stringify(json);
      appendChunk(assistantBody, text);
    } catch (err) {
      appendChunk(assistantBody, `\n[Error parsing JSON: ${err.message}]`);
    }
    return text.trim();
  }

  // ---------- VOICE ----------
  async function maybeSpeak(text, mode) {
    if (!text) return;
    if (mode === 'Off') return;

    if (mode === 'Local Voice') {
      await speakLocal(text);
      return;
    }

    if (mode === 'D-ID Avatar') {
      try {
        const res = await fetch('/api/did-speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, mode })
        });
        const data = await res.json();
        console.log('[voice] did-speak POST ->', data);

        if (data?.fallback) {
          await speakLocal(text);
          return;
        }

        if (data?.result_url) {
          await playUrlSmart(data.result_url);
          return;
        }

        if (data?.id) {
          const url = await pollDidResult(data.id, 35000);
          console.log('[voice] polled result url:', url);
          if (url) await playUrlSmart(url);
          else await speakLocal(text);
          return;
        }

        await speakLocal(text);
      } catch (err) {
        console.error('[voice] D-ID error', err);
        await speakLocal(text);
      }
    }
  }

  async function speakLocal(text) {
    if (!('speechSynthesis' in window)) {
      console.warn('[voice] speechSynthesis not available');
      return;
    }
    // Wait for voices if needed
    await new Promise(res => {
      const v = window.speechSynthesis.getVoices();
      if (v && v.length) return res();
      window.speechSynthesis.onvoiceschanged = () => res();
      setTimeout(res, 750);
    });

    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    window.speechSynthesis.speak(u);
    console.log('[voice] spoke locally via speechSynthesis');
  }

  async function pollDidResult(id, timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await fetch(`/api/did-speak?id=${encodeURIComponent(id)}`);
      const j = await r.json();
      const status = j?.status || j?.state;
      const url =
        j?.result_url || j?.result_url_mp4 || j?.result?.url || j?.audio?.url || '';
      console.log('[voice] poll status=', status, 'url=', url);
      if ((status === 'done' || status === 'complete') && url) return url;
      await new Promise(res => setTimeout(res, 1200));
    }
    return null;
  }

  async function playUrlSmart(url) {
    try {
      // quick guess by extension
      const lower = url.toLowerCase();
      let contentType = '';
      try {
        const head = await fetch(url, { method: 'HEAD' });
        contentType = head.headers.get('content-type') || '';
      } catch {}

      console.log('[voice] play url:', url, 'ctype=', contentType);

      // decide which element to use
      const isVideo = contentType.startsWith('video/') || lower.endsWith('.mp4') || lower.endsWith('.webm');

      if (isVideo) {
        videoEl.src = url;
        videoEl.volume = 1;
        videoEl.muted = false;
        await videoEl.play();
        console.log('[voice] playing VIDEO');
      } else {
        audioEl.src = url;
        audioEl.volume = 1;
        audioEl.muted = false;
        await audioEl.play();
        console.log('[voice] playing AUDIO');
      }
    } catch (err) {
      console.warn('[voice] media play blocked, waiting for next gesture', err);
    }
  }

  // ---------- EVENTS ----------
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = (ui.input.value || '').trim();
    if (!msg) return;
    ui.input.value = '';
    send(msg);
  });

  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ui.form.requestSubmit();
    }
  });

  // Debug helper
  window.__send = () => {
    const msg = (ui.input.value || '').trim();
    if (!msg) return;
    ui.input.value = '';
    send(msg);
  };
})();
