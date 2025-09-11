/* Keilani Chat — single-file client
   - Works with your existing chat.html controls
   - Voice modes: Off | Local Voice | D-ID Avatar
   - SSE and non-SSE supported
*/

(() => {
  // ---------- UI WIRING ----------
  const ui = {
    // feed container where assistant/user bubbles go
    feed: document.querySelector('[data-feed]') || document.getElementById('feed') || document.querySelector('.feed'),

    // core controls (these exist in your latest page)
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

  // Assert required nodes
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

  // A single, hidden <audio> we reuse for local & D-ID playback
  let audio = document.getElementById('voice-audio');
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'voice-audio';
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
  }

  console.log('[chat.js] UI found:', {
    feed: !!ui.feed, input: !!ui.input, form: !!ui.form, sendBtn: !!ui.sendBtn,
    model: !!ui.model, api: !!ui.api, token: !!ui.token, stream: !!ui.stream,
    sse: !!ui.sse, voice: !!ui.voice
  });

  // Try to unlock audio on first user interaction (iOS)
  const unlockAudio = () => {
    audio.play().then(() => {
      audio.pause();
      audio.currentTime = 0;
      console.log('[chat.js] Audio unlocked');
    }).catch(() => {});
    window.removeEventListener('click', unlockAudio, true);
    window.removeEventListener('touchstart', unlockAudio, true);
  };
  window.addEventListener('click', unlockAudio, true);
  window.addEventListener('touchstart', unlockAudio, true);

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
    return body; // return the content node so we can append stream chunks
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

    // Render user bubble
    bubble('user', message);

    // Render assistant placeholder (and keep handle for stream)
    const assistantBody = bubble('assistant', '', { muted: doStream });

    // Build payload (your server already knows how to consume this shape)
    const payload = {
      model: theModel,
      messages: [{ role: 'user', content: message }],
      stream: doStream,
      expectSSE
    };
    if (clientToken) payload.client_token = clientToken;

    // Fire request
    const headers = { 'Content-Type': 'application/json' };
    let resp;
    try {
      resp = await fetch(apiURL, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (err) {
      appendChunk(assistantBody, `\n[Error: failed to connect: ${err.message}]`);
      return;
    }

    // Route based on streaming mode
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
      buf = parts.pop(); // unfinished

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
        } catch (e) {
          // If server ever sends a text frame, fallback to append
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
      // Try common shapes
      text =
        json?.choices?.[0]?.message?.content ??
        json?.message?.content ??
        json?.content ??
        (typeof json === 'string' ? json : '');

      if (!text) {
        text = JSON.stringify(json);
      }
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
      tryLocalTTS(text);
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

        // If Netlify function falls back (no D-ID config), do local TTS
        if (data?.fallback) {
          tryLocalTTS(text);
          return;
        }

        // Two possible shapes: direct result_url OR id that we must poll
        if (data?.result_url) {
          await playUrl(data.result_url);
        } else if (data?.id) {
          const url = await pollDidResult(data.id, 30000);
          if (url) await playUrl(url);
          else tryLocalTTS(text);
        } else {
          // Unknown reply: fallback
          tryLocalTTS(text);
        }
      } catch (err) {
        console.error('[voice] D-ID error', err);
        tryLocalTTS(text);
      }
    }
  }

  function tryLocalTTS(text) {
    // If SpeechSynthesis is not available, noop
    if (!('speechSynthesis' in window)) return;
    // Stop any previous utterance
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    // Optional: tweak for mobile clarity
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    window.speechSynthesis.speak(u);
  }

  async function playUrl(url) {
    try {
      audio.src = url;
      await audio.play();
    } catch (err) {
      console.warn('[voice] Audio.play() blocked, waiting for next gesture', err);
    }
  }

  async function pollDidResult(id, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await fetch(`/api/did-speak?id=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j?.status === 'done' && j?.result_url) return j.result_url;
      await new Promise(res => setTimeout(res, 1000));
    }
    return null;
  }

  // ---------- EVENTS ----------
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = (ui.input.value || '').trim();
    if (!msg) return;
    const toSend = msg;
    ui.input.value = '';
    send(toSend);
  });

  // Allow Enter to send, Shift+Enter for newline
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ui.form.requestSubmit();
    }
  });

  // For debugging convenience
  window.__send = () => {
    const msg = (ui.input.value || '').trim();
    if (!msg) return;
    ui.input.value = '';
    send(msg);
  };
})();
