/* Keilani Chat — streaming + JSON + Voice (Local / D-ID)
   - Fixes D-ID playback by using absolute result_url
   - Works with CSP (no inline JS), local vendor libs, and Netlify routes
*/

(() => {
  // ---------- UI ----------
  const ui = {
    feed: document.getElementById('feed'),
    input: document.getElementById('input'),
    form: document.getElementById('form'),
    sendBtn: document.getElementById('sendBtn'),
    model: document.getElementById('model'),
    api: document.getElementById('api'),
    token: document.getElementById('token'),
    stream: document.getElementById('stream'),
    sse: document.getElementById('sse'),
    voice: document.getElementById('voice'),

    save: document.getElementById('save'),
    exportBtn: document.getElementById('export'),
    clear: document.getElementById('clear'),
    reset: document.getElementById('reset'),
  };

  // Minimal state
  let sid = null;

  // ---------- Helpers ----------
  const now = () => (window.dayjs ? dayjs().format('YYYY-MM-DD HH:mm:ss') : new Date().toLocaleString());

  const toast = (msg) => console.log('[chat.js]', msg);

  function addBubble(role, text) {
    const el = document.createElement('div');
    el.className = `msg ${role === 'user' ? 'you' : ''}`;
    el.innerHTML = `
      <div class="meta">${role === 'user' ? 'You' : 'Keilani'} <span class="right">${now()}</span></div>
      <div class="body"></div>
    `;
    const body = el.querySelector('.body');

    // Render markdown if available
    if (window.marked && typeof marked.parse === 'function') {
      body.innerHTML = marked.parse(text || '');
      if (window.hljs) body.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
    } else {
      body.textContent = text || '';
    }
    ui.feed.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return body; // return the body for streaming append
  }

  function setBusy(b) {
    ui.sendBtn.disabled = b;
    ui.input.disabled = b;
  }

  // ---------- Audio unlock (first interaction) ----------
  (function unlockAudioOnce() {
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      try {
        const a = new Audio();
        // 1-frame silent mp3 (data URL)
        a.src = 'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAA';
        a.play().catch(() => {});
      } catch {}
      console.log('[chat.js] Audio unlocked');
      window.removeEventListener('click', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
    };
    window.addEventListener('click', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
  })();

  // ---------- Voice: local (SpeechSynthesis) ----------
  function speakLocal(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.0;
    u.pitch = 1.0;
    // Pick a voice if available
    const v = window.speechSynthesis.getVoices().find((v) => /en/i.test(v.lang));
    if (v) u.voice = v;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  // ---------- Voice: D-ID ----------
  function getVoiceMode() {
    return (ui.voice?.value || 'off').toLowerCase(); // 'off' | 'audio' | 'did'
  }

  async function speakWithDID(text) {
    try {
      const res = await fetch('/api/did-speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mode: 'D-ID Avatar' }),
      });
      const data = await res.json();

      const url = data?.result_url;
      const type = data?.content_type || '';

      if (!url || !/^https?:\/\//i.test(url)) {
        console.error('Invalid D-ID result', data);
        toast('D-ID did not return a playable media URL.');
        return;
      }
      await playUrlSmart(url, type);
    } catch (err) {
      console.error('D-ID speak failed', err);
      toast('Voice (D-ID) failed.');
    }
  }

  async function playUrlSmart(url, contentType = '') {
    const isVideo = contentType.startsWith('video') || /\.mp4(\?|$)/i.test(url);
    if (isVideo) return playVideo(url);
    return playAudio(url);
  }

  function playAudio(url) {
    return new Promise((resolve, reject) => {
      const a = new Audio();
      a.crossOrigin = 'anonymous';
      a.src = url;           // MUST be absolute
      a.preload = 'auto';
      a.autoplay = true;
      a.onplay = () => resolve();
      a.onerror = () => reject(new Error('Audio playback error'));
      // try to start early on canplay
      a.oncanplay = () => a.play().catch(reject);
    });
  }

  function playVideo(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.src = url;           // MUST be absolute
      v.crossOrigin = 'anonymous';
      v.playsInline = true;  // iOS
      v.muted = true;        // allow autoplay, unmute after start
      v.autoplay = true;
      v.controls = true;

      Object.assign(v.style, {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        width: '280px',
        borderRadius: '12px',
        boxShadow: '0 10px 28px rgba(0,0,0,.35)',
        zIndex: 9999
      });

      v.onplay = () => {
        setTimeout(() => { try { v.muted = false; v.volume = 1; } catch {} }, 160);
        resolve();
      };
      v.onerror = () => reject(new Error('Video playback error'));

      // If already exists, replace
      const old = document.querySelector('video[data-did]');
      if (old) old.remove();

      v.setAttribute('data-did', '1');
      document.body.appendChild(v);
    });
  }

  // ---------- Chat send ----------
  async function send(text) {
    const api = ui.api.value.trim() || '/api/chat';
    const model = ui.model.value;
    const clientToken = ui.token.value.trim();
    const useStream = !!ui.stream.checked;
    const expectsSSE = !!ui.sse.checked;

    const userBody = addBubble('user', text);
    userBody.textContent = text;

    const assistantBody = addBubble('assistant', '…');

    setBusy(true);

    try {
      if (useStream && expectsSSE) {
        // SSE mode
        const r = await fetch(api, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(clientToken ? { 'X-Client-Token': clientToken } : {}),
            ...(sid ? { 'X-Session-Id': sid } : {}),
          },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], stream: true }),
        });
        // capture session id if server returns it as header
        const sidHdr = r.headers.get('x-session-id');
        if (sidHdr) sid = sidHdr;

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let acc = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // naive SSE parse: lines starting with "data: "
          chunk.split('\n').forEach((line) => {
            const m = line.match(/^data:\s*(.+)$/);
            if (!m) return;
            try {
              const evt = JSON.parse(m[1]);
              if (evt?.delta?.content) {
                acc += evt.delta.content;
                assistantBody.textContent = acc;
              }
            } catch {}
          });
        }

        // voice (after stream)
        if (acc && getVoiceMode() === 'audio') speakLocal(acc);
        if (acc && getVoiceMode() === 'did') await speakWithDID(acc);

      } else {
        // JSON mode
        const r = await fetch(api, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(clientToken ? { 'X-Client-Token': clientToken } : {}),
            ...(sid ? { 'X-Session-Id': sid } : {}),
          },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], stream: false }),
        });
        const sidHdr = r.headers.get('x-session-id');
        if (sidHdr) sid = sidHdr;

        if (!r.ok) {
          const t = await r.text();
          assistantBody.textContent = `Error: ${t}`;
        } else {
          const json = await r.json();
          const content = json?.choices?.[0]?.message?.content || json?.content || '(no content)';
          assistantBody.textContent = content;

          if (getVoiceMode() === 'audio') speakLocal(content);
          if (getVoiceMode() === 'did') await speakWithDID(content);
        }
      }
    } catch (err) {
      console.error(err);
      assistantBody.textContent = `⚠️ ${err.message || err}`;
    } finally {
      setBusy(false);
    }
  }

  // ---------- Wire up ----------
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = (ui.input.value || '').trim();
    if (!text) return;
    send(text);
    ui.input.value = '';
  });

  ui.clear.addEventListener('click', () => {
    ui.feed.innerHTML = '';
    sid = null;
  });

  ui.reset.addEventListener('click', () => {
    sid = null;
    toast('Session reset.');
  });

  ui.exportBtn.addEventListener('click', () => {
    const text = [...ui.feed.querySelectorAll('.msg')]
      .map((m) => m.innerText.replace(/\n{3,}/g, '\n\n'))
      .join('\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `keilani-chat-${Date.now()}.txt`;
    a.click();
  });

  // expose a dev helper
  window.__send = (t) => send(t);

  console.log('[chat.js] UI found:', {
    feed: !!ui.feed, input: !!ui.input, form: !!ui.form, sendBtn: !!ui.sendBtn,
    model: !!ui.model, api: !!ui.api, token: !!ui.token,
    stream: !!ui.stream, sse: !!ui.sse, voice: !!ui.voice
  });
  console.log('[chat.js] Ready. Tip: call window.__send() in console to force a send.');
})();
