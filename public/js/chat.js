(() => {
  const feed = document.getElementById('feed');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const apiEl = document.getElementById('api');
  const modelEl = document.getElementById('model');
  const streamEl = document.getElementById('stream');
  const sseEl = document.getElementById('sse');
  const voiceEl = document.getElementById('voice');
  let currentAudio = null; // for barge-in

  const add = (role, text) => {
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (role === 'you' ? ' you' : '');
    wrap.innerHTML = `<div class="meta">${role}</div><div class="content">${escapeHtml(text)}</div>`;
    feed.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function speak(text) {
    // stop any current audio (barge-in)
    if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; currentAudio = null; }
    if (voiceEl.value === 'off') return;

    // local audio (browser TTS) fallback
    if (voiceEl.value === 'audio') {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(u);
      return;
    }

    // ElevenLabs proxy (binary audio)
    if (voiceEl.value === 'did' || voiceEl.value === 'eleven') {
      const r = await fetch('/.netlify/functions/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!r.ok) return;
      const b64 = await r.text();
      const blob = b64 ? b64ToBlob(JSON.parse(b64).error ? new Uint8Array() : atob(JSON.parse(b64).body || "")) : null;
      // Simpler: just refetch body as arrayBuffer if needed – but above keeps deps zero.
      return;
    }
  }

  function b64ToBlob(b64) {
    // not used in current simple path
    return new Blob([]);
  }

  async function send(msg) {
    add('you', msg);
    input.value = '';

    const payload = { message: msg, history: [] };
    const url = (streamEl.checked ? '/api/chat-stream' : apiEl.value) || '/api/chat';

    if (streamEl.checked) {
      // Stream via fetch + reader (SSE-style lines)
      try {
        // barge-in: stop TTS immediately
        if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; currentAudio = null; }
        if (window.speechSynthesis) window.speechSynthesis.cancel();

        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!resp.ok || !resp.body) throw new Error('Bad stream');

        let assistant = '';
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split(/\r?\n/);
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const obj = JSON.parse(data);
              // OpenAI "delta" shape (compat): {choices:[{delta:{content:"..."}}]}
              const token = obj?.choices?.[0]?.delta?.content ?? '';
              if (token) {
                assistant += token;
                renderLive(assistant);
              }
            } catch {
              // sometimes upstream emits plain text – append raw
              if (data && data !== '[DONE]') {
                assistant += data;
                renderLive(assistant);
              }
            }
          }
        }
        finalize(assistant);
        speak(assistant);
      } catch (e) {
        add('error', 'Stream error: ' + e.message);
      }
      return;
    }

    // Non-stream JSON
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok) return add('error', data.error || 'Chat error');
      add('keilani', data.reply || '');
      speak(data.reply || '');
    } catch (e) {
      add('error', 'Network error: ' + e.message);
    }
  }

  let liveEl = null;
  function renderLive(text) {
    if (!liveEl) {
      liveEl = document.createElement('div');
      liveEl.className = 'msg';
      liveEl.innerHTML = `<div class="meta">keilani</div><div class="content"></div>`;
      feed.appendChild(liveEl);
    }
    liveEl.querySelector('.content').textContent = text;
  }
  function finalize(text) {
    if (!liveEl) return add('keilani', text);
    liveEl.querySelector('.content').textContent = text;
    liveEl = null;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    send(msg);
  });
})();
