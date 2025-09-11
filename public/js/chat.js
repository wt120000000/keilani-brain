// public/js/chat.js
(() => {
  const $ = (sel) => document.querySelector(sel);
  const ui = {
    feed: $('#feed') || $('#main'),
    input: $('#input') || $('textarea#input'),
    form: $('#form') || $('form#form'),
    sendBtn: $('#send'),
    model: $('#model'),
    api: $('#api'),
    token: $('#token'),
    stream: $('#stream'),
    sse: $('#sse'),
    voice: $('#voice'),
    voiceAudio: $('#voiceAudio'),
    voiceVideo: $('#voiceVideo'),
    sid: $('#sid'),
    tokens: $('#tokens')
  };

  // Basic sanity check
  const need = (...keys) => {
    for (const k of keys) {
      if (!ui[k]) throw new Error(`Missing UI node: ${k}`);
    }
  };
  need('feed','input','form','sendBtn','model','api','stream','sse','voice');

  // Audio unlock on first gesture (required on iOS/Android)
  let audioUnlocked = false;
  const unlock = () => {
    if (audioUnlocked) return;
    try {
      ui.voiceAudio?.play().catch(()=>{});
      ui.voiceAudio?.pause?.();
      audioUnlocked = true;
      console.log('[chat.js] Audio unlocked');
    } catch {}
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // Helpers
  const now = () => new Date().toISOString().replace('T',' ').split('.')[0];
  const bubble = (role, text) => {
    const el = document.createElement('div');
    el.className = `msg ${role === 'user' ? 'you' : 'keilani'}`;
    el.textContent = text;
    ui.feed.appendChild(el);
    ui.feed.scrollTop = ui.feed.scrollHeight;
  };

  // --- Chat send (SSE or JSON) (unchanged core behavior) ---
  async function sendText(message) {
    if (!message.trim()) return;

    bubble('user', message);

    const payload = {
      model: ui.model.value,
      messages: [{ role: 'user', content: message }],
      stream: !!ui.stream.checked,
      expectSSE: !!ui.sse.checked,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (ui.token?.value) headers['X-Client-Token'] = ui.token.value;

    if (payload.stream && payload.expectSSE) {
      // SSE streaming
      const res = await fetch(ui.api.value || '/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        bubble('assistant', `⚠ ${res.status} ${res.statusText}`);
        return;
      }
      // We expect event-stream; fallback to text if proxy rewraps
      const reader = res.body?.getReader();
      if (!reader) {
        // not a stream, try parse JSON
        try {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content || JSON.stringify(data);
          bubble('assistant', text);
          await maybeSpeak(text);
        } catch {
          const raw = await res.text();
          bubble('assistant', raw || '(empty)');
        }
        return;
      }
      // Stream chunks
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += new TextDecoder().decode(value);
        // naive assemble; your server is already formatting nicely
      }
      // Try to extract final assistant text if your server sends deltas
      // Fallback: show raw
      try {
        const lastLine = acc.trim().split('\n').filter(Boolean).pop() || '';
        const maybe = JSON.parse(lastLine.replace(/^data:\s*/,''));
        const text = maybe?.choices?.[0]?.delta?.content || maybe?.choices?.[0]?.message?.content;
        if (text) {
          bubble('assistant', text);
          await maybeSpeak(text);
        } else {
          bubble('assistant', acc);
        }
      } catch {
        bubble('assistant', acc);
      }
      return;
    }

    // Non-stream
    const res = await fetch(ui.api.value || '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      bubble('assistant', `⚠ ${res.status} ${res.statusText}`);
      return;
    }
    let data;
    try { data = await res.json(); } catch { data = null; }
    const text = data?.choices?.[0]?.message?.content
      ?? (typeof data === 'string' ? data : JSON.stringify(data));
    bubble('assistant', text);
    await maybeSpeak(text);
  }

  // --- Voice routing ---
  // Voice dropdown values in chat.html:
  //  - "off"
  //  - "local"
  //  - "did"         (voice only via D-ID TTS)
  //  - "did-avatar"  (video via D-ID talks)
  async function maybeSpeak(text) {
    const v = (ui.voice?.value || 'off').toLowerCase();

    if (v === 'off') return;

    if (v === 'local') {
      // Hook up your local TTS if you want (left as no-op for now)
      return;
    }

    if (v === 'did') {
      // Request D-ID TTS and play audio
      const res = await fetch('/api/did-speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mode: 'voice' })
      });
      const data = await res.json().catch(()=> ({}));
      if (!res.ok) {
        console.warn('did-speak voice error', data);
        return;
      }
      const url = data?.url;
      if (!url) return;
      ui.voiceVideo?.pause?.();
      ui.voiceVideo?.removeAttribute('src');
      ui.voiceAudio.src = url;
      try { await ui.voiceAudio.play(); } catch (e) { console.warn('audio play blocked', e); }
      return;
    }

    if (v === 'did-avatar') {
      // Request D-ID avatar talk and play video
      const res = await fetch('/api/did-speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mode: 'avatar' })
      });
      const data = await res.json().catch(()=> ({}));
      if (!res.ok) {
        console.warn('did-speak avatar error', data);
        return;
      }
      const url = data?.url;
      if (!url) return;
      ui.voiceAudio?.pause?.();
      ui.voiceAudio?.removeAttribute('src');
      ui.voiceVideo.src = url;
      ui.voiceVideo.style.display = 'block'; // show if you want a visible preview
      try { await ui.voiceVideo.play(); } catch (e) { console.warn('video play blocked', e); }
      return;
    }
  }

  // Form handlers
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = ui.input.value;
    ui.input.value = '';
    sendText(msg);
  });

  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ui.form.requestSubmit();
    }
  });

  // Expose for debugging: in devtools, type __send("hi")
  window.__send = (t) => sendText(t);

  // Log found UI once
  console.log('[chat.js] UI found:', {
    feed: !!ui.feed, input: !!ui.input, form: !!ui.form,
    sendBtn: !!ui.sendBtn, model: !!ui.model, api: !!ui.api,
    token: !!ui.token, stream: !!ui.stream, sse: !!ui.sse, voice: !!ui.voice
  });
})();
