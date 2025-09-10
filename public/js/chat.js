/* Keilani Chat – App Script (CSP-safe, no inline JS) */
/* global marked, hljs, DOMPurify, dayjs */

(() => {
  // ---------- DOM helpers ----------
  const $ = (s, p = document) => p.querySelector(s);
  const $$ = (s, p = document) => [...p.querySelectorAll(s)];
  const on = (el, ev, fn, opts) => el.addEventListener(ev, fn, opts);

  // ---------- Elements (ids must match chat.html) ----------
  const modelSel   = $('#model');
  const apiInput   = $('#api');
  const tokenInput = $('#clientToken');
  const streamChk  = $('#stream');
  const sseChk     = $('#sse');
  const saveBtn    = $('#save');
  const resetBtn   = $('#reset');
  const exportBtn  = $('#export');
  const clearBtn   = $('#clear');
  const sendBtn    = $('#send');
  const form       = $('#composer');
  const promptEl   = $('#prompt');
  const feed       = $('#feed');
  const sidBadge   = $('#sid');
  const tokensChip = $('#tokens');

  // ---------- Persistence ----------
  const LS_KEYS = {
    api: 'kln.chat.api',
    model: 'kln.chat.model',
    token: 'kln.chat.client_token',
    stream: 'kln.chat.stream',
    sse: 'kln.chat.sse',
    sid: 'kln.chat.sid',
  };
  const ls = {
    get: (k, d = '') => {
      try { const v = localStorage.getItem(k); return v ?? d; } catch { return d; }
    },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- SID ----------
  const newSID = () => Math.random().toString(16).slice(2, 10);
  const SID = (() => {
    let v = ls.get(LS_KEYS.sid);
    if (!v) { v = newSID(); ls.set(LS_KEYS.sid, v); }
    return v;
  })();
  if (sidBadge) sidBadge.textContent = SID;

  // ---------- Load persisted config ----------
  (function hydrate() {
    const api = ls.get(LS_KEYS.api, apiInput?.value || '');
    if (apiInput) apiInput.value = api;

    const model = ls.get(LS_KEYS.model, modelSel?.value || 'gpt-5');
    if (modelSel) modelSel.value = model;

    const tok = ls.get(LS_KEYS.token, tokenInput?.value || '');
    if (tokenInput && tok) tokenInput.value = tok;

    const stream = ls.get(LS_KEYS.stream, '1') === '1';
    if (streamChk) streamChk.checked = stream;

    const sse = ls.get(LS_KEYS.sse, '1') === '1';
    if (sseChk) sseChk.checked = sse;
  })();

  // ---------- Utils ----------
  const fmtTime = () => dayjs().format('h:mm:ss A');
  const sanitize = (html) =>
    DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i });

  const md = (txt) => {
    try {
      const html = marked.parse(txt ?? '');
      return sanitize(html);
    } catch {
      return sanitize((txt ?? '').replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s])));
    }
  };

  const showError = (text) => {
    const wrap = document.createElement('div');
    wrap.className = 'msg error';
    wrap.innerHTML = `
      <div class="row">
        <div class="bubble">
          <div class="code"><pre><code class="language-json">${sanitize(text)}</code></pre></div>
        </div>
        <div class="meta">${fmtTime()}</div>
      </div>`;
    feed.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
    try { $$('pre code', wrap).forEach(b => hljs.highlightElement(b)); } catch {}
  };

  const appendUser = (text) => {
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    wrap.innerHTML = `
      <div class="row">
        <div class="bubble">${md(text)}</div>
        <div class="meta">${fmtTime()}</div>
      </div>`;
    feed.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  const appendBotStart = () => {
    const wrap = document.createElement('div');
    wrap.className = 'msg bot';
    wrap.innerHTML = `
      <div class="row">
        <div class="bubble"><div class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>
        <div class="meta">${fmtTime()}</div>
      </div>`;
    feed.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return wrap;
  };

  const updateBotBubble = (wrap, html) => {
    const bubble = $('.bubble', wrap);
    if (bubble) bubble.innerHTML = html;
    try { $$('pre code', wrap).forEach(b => hljs.highlightElement(b)); } catch {}
  };

  const setTokens = (n, rate) => {
    if (!tokensChip) return;
    tokensChip.textContent = `Tokens: ${n} • ${rate || '0'}/s`;
  };

  // ---------- Save config ----------
  const persist = () => {
    if (apiInput)   ls.set(LS_KEYS.api, apiInput.value.trim());
    if (modelSel)   ls.set(LS_KEYS.model, modelSel.value);
    if (tokenInput) ls.set(LS_KEYS.token, tokenInput.value.trim());
    if (streamChk)  ls.set(LS_KEYS.stream, streamChk.checked ? '1' : '0');
    if (sseChk)     ls.set(LS_KEYS.sse, sseChk.checked ? '1' : '0');
  };

  if (saveBtn)  on(saveBtn, 'click', persist);
  if (resetBtn) on(resetBtn, 'click', () => { ls.del(LS_KEYS.sid); location.reload(); });
  if (clearBtn) on(clearBtn, 'click', () => { feed.innerHTML = ''; setTokens(0, '0'); });

  if (exportBtn) on(exportBtn, 'click', () => {
    const lines = $$('.msg', feed).map(m => {
      const who = m.classList.contains('user') ? 'You' : (m.classList.contains('bot') ? 'Keilani' : 'Sys');
      const text = $('.bubble', m)?.textContent || '';
      const t = $('.meta', m)?.textContent || '';
      return `[${t}] ${who}: ${text}`;
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `keilani-chat-${SID}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------- Networking ----------
  async function sendMessage(ev) {
    ev?.preventDefault?.();

    const api   = apiInput?.value.trim();
    const model = modelSel?.value || 'gpt-5';
    const cTok  = tokenInput?.value.trim() || '';
    const useStream = !!(streamChk?.checked);
    const expectSSE = !!(sseChk?.checked);
    const content = promptEl?.value.trim();

    if (!api) { showError('Missing API URL'); return; }
    if (!content) return;

    // Persist current config
    persist();

    // Show user message
    appendUser(content);

    // Prepare bot container
    const botWrap = appendBotStart();

    // Build payload for our proxy
    const body = {
      model,
      stream: useStream,
      messages: [{ role: 'user', content }],
      // Pass through client token; server ignores if not needed
      client_token: cTok || undefined,
      sid: SID,
    };

    try {
      if (useStream && expectSSE) {
        await sseFetch(api, body, botWrap);
      } else {
        await jsonFetch(api, body, botWrap);
      }
    } catch (e) {
      updateBotBubble(botWrap, md(`**[Error]** ${e.message || e}`));
    } finally {
      if (promptEl) promptEl.value = '';
    }
  }

  async function jsonFetch(api, body, botWrap) {
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => `${res.status} ${res.statusText}`);
      showError(`[Error] HTTP ${res.status} — ${errText}`);
      return;
    }
    const data = await res.json();
    const txt = data?.message || data?.content || data?.choices?.[0]?.message?.content || '';
    updateBotBubble(botWrap, md(txt || '_[no content]_'));
    setTokens(data?.usage?.total_tokens ?? 0, '0');
  }

  async function sseFetch(api, body, botWrap) {
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => `${res.status} ${res.statusText}`);
      showError(`[Error] HTTP ${res.status} — ${errText}`);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let accText = '';

    const flush = () => {
      if (!buf) return;
      // Parse SSE lines (data: ...)
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.startsWith('data:')) continue;
        const payload = ln.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          if (chunk?.error) throw new Error(chunk.error);
          const delta = chunk?.delta ?? chunk?.content ?? '';
          if (delta) {
            accText += delta;
            updateBotBubble(botWrap, md(accText));
          }
          if (chunk?.usage?.total_tokens != null) {
            setTokens(chunk.usage.total_tokens, chunk.rate || '0');
          }
        } catch { /* ignore malformed lines */ }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      flush();
    }
    // Final flush
    buf += dec.decode();
    flush();

    if (!accText) {
      updateBotBubble(botWrap, md('_[no content]_'));
    }
  }

  // ---------- Keyboard + Click handlers ----------
  if (form) on(form, 'submit', sendMessage);
  if (sendBtn) on(sendBtn, 'click', sendMessage);

  if (promptEl) {
    // Enter to send; Shift+Enter for newline
    on(promptEl, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // ---------- Warm greeting for empty feed ----------
  if (!feed.querySelector('.msg')) {
    const wrap = document.createElement('div');
    wrap.className = 'msg bot';
    wrap.innerHTML = `
      <div class="row">
        <div class="bubble">
          <p>Hi! I’m here and working. How can I help today? If you’re testing, you can try:</p>
          <ul>
            <li>Ask a quick question</li>
            <li>Summarize a paragraph</li>
            <li>Generate a short code snippet</li>
            <li>Translate a sentence</li>
          </ul>
        </div>
        <div class="meta">${fmtTime()}</div>
      </div>`;
    feed.appendChild(wrap);
  }
})();
