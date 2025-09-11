/* Keilani chat client — ultra-tolerant v3.3
 * - Finds elements aggressively (or creates them)
 * - Always wires submit (Enter / button / form)
 * - Streams when Expect SSE is ON, JSON when OFF
 * - Console self-test logs what it attached to
 */

(() => {
  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const textOf = (el) => (el?.textContent || '').trim().toLowerCase();

  const log = (...a) => console.log('[chat.js]', ...a);
  const warn = (...a) => console.warn('[chat.js]', ...a);
  const err = (...a) => console.error('[chat.js]', ...a);

  // ---------- find/ensure UI ----------
  function ensureFeed() {
    // Try common ids/classes
    let el =
      $('#feed') ||
      $('.feed') ||
      $('#messages') ||
      $('.messages') ||
      $('#chat-feed') ||
      $('.chat-feed');

    if (!el) {
      // Create one if missing
      el = document.createElement('div');
      el.id = 'feed';
      el.style.cssText =
        'max-height:48vh;overflow:auto;padding:.75rem;border-radius:.75rem;border:1px solid rgba(255,255,255,.08);margin:.75rem 0;';
      // put right above composer if we can; else append to body
      const composerHost =
        $('#composer')?.parentElement ||
        $('textarea')?.parentElement ||
        $('[contenteditable="true"]')?.parentElement ||
        $('form') ||
        $('main') ||
        document.body;
      composerHost.insertBefore(el, composerHost.firstChild);
    }
    return el;
  }

  function findInput() {
    // 1) explicit ids/classes first
    let el =
      $('#composer') ||
      $('.composer') ||
      $('#input') ||
      $('.input') ||
      $('#prompt') ||
      $('.prompt') ||
      $('#message') ||
      $('.message');
    // 2) textarea
    if (!el) el = $('textarea');
    // 3) contenteditable (single line div or similar)
    if (!el) el = $('[contenteditable="true"]');
    return el || null;
  }

  function findSendButton() {
    // 1) by id/class
    let b =
      $('#send') ||
      $('.send') ||
      $('#sendBtn') ||
      $('.chat-send') ||
      $('button[type="submit"]');
    if (b) return b;
    // 2) by visible text “Send”
    for (const btn of $$('button')) {
      const t = textOf(btn);
      if (t === 'send' || t === 'send ↵' || t === 'send↵' || t.startsWith('send')) return btn;
    }
    return null;
  }

  function findForm(input, sendBtn) {
    return (
      $('form#chat') ||
      input?.closest('form') ||
      sendBtn?.closest('form') ||
      $('form')
    );
  }

  function findToggle(idCandidates, fallbackChecked = true) {
    for (const id of idCandidates) {
      const el = document.getElementById(id) || document.querySelector(`#${id}, .${id}, [name="${id}"]`);
      if (el && 'checked' in el) return el;
    }
    // fabricate hidden checkbox (so logic still works)
    const fake = document.createElement('input');
    fake.type = 'checkbox';
    fake.checked = fallbackChecked;
    return fake;
  }

  function findValue(elCandidates, defaultVal = '') {
    for (const id of elCandidates) {
      const el = document.getElementById(id) || document.querySelector(`#${id}, .${id}, [name="${id}"]`);
      if (el && 'value' in el) return el;
    }
    const temp = document.createElement('input');
    temp.type = 'text';
    temp.value = defaultVal;
    return temp;
  }

  // ---------- bubble rendering ----------
  function bubble(feed, role, text, { asHTML = false, meta = true } = {}) {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.dataset.role = role;
    msg.style.cssText = 'margin:.5rem 0;';

    const who = document.createElement('div');
    who.className = 'who';
    who.style.cssText = 'opacity:.7;font-size:.85rem;margin-bottom:.25rem;';
    who.textContent = role === 'user' ? 'You' : 'Keilani';

    const body = document.createElement('div');
    body.className = 'content';
    body.style.cssText =
      'white-space:pre-wrap;line-height:1.5;border:1px solid rgba(255,255,255,.08);padding:.75rem;border-radius:.6rem;';
    if (asHTML) body.innerHTML = text || '';
    else body.textContent = text || '';

    msg.appendChild(who);
    msg.appendChild(body);

    if (meta) {
      const ts = document.createElement('div');
      ts.className = 'meta';
      ts.style.cssText = 'opacity:.55;font-size:.75rem;margin-top:.25rem;';
      ts.textContent = new Date().toISOString().replace('T',' ').slice(0,19);
      msg.appendChild(ts);
    }

    feed.appendChild(msg);
    feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    return body;
  }

  function showError(feed, text) {
    bubble(feed, 'assistant', `⚠️ ${text}`);
  }

  // ---------- streaming & JSON parsing ----------
  async function readSSE(stream, onEvent) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalText = '';

    const push = (s) => {
      if (!s) return;
      finalText += s;
      onEvent?.({ type: 'chunk', data: s });
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buf += chunk;

      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]' || payload === '[done]' || payload === '__END__') {
          onEvent?.({ type: 'done', final: finalText });
          return;
        }
        try {
          const obj = JSON.parse(payload);
          let delta =
            obj?.choices?.[0]?.delta?.content ??
            (Array.isArray(obj?.choices?.[0]?.delta?.content)
              ? obj.choices[0].delta.content.map(x => x?.text || '').join('')
              : undefined) ??
            obj?.delta ?? obj?.content ?? obj?.text ?? obj?.message ?? '';
          if (typeof delta !== 'string') delta = String(delta || '');
          if (delta) push(delta);
          if (obj?.error) onEvent?.({ type: 'error', data: obj.error });
        } catch {
          push(payload);
        }
      }
    }
    onEvent?.({ type: 'done', final: finalText });
  }

  async function parseJSON(resp) {
    const t = await resp.text();
    try {
      const j = JSON.parse(t);
      const pick =
        j?.output_text ??
        j?.message ??
        j?.response ??
        j?.output ??
        j?.content ??
        j?.text ??
        j?.choices?.[0]?.message?.content ??
        j?.choices?.[0]?.delta?.content ??
        '';
      if (typeof pick === 'string' && pick) return pick;
      return typeof j === 'string' ? j : JSON.stringify(j, null, 2);
    } catch {
      return t;
    }
  }

  // ---------- state wiring ----------
  const feed = ensureFeed();
  const input = findInput();
  const sendBtn = findSendButton();
  const form = findForm(input, sendBtn);

  // Config controls (very tolerant)
  const apiEl   = findValue(['api','endpoint','api-url'], 'https://api.keilani.ai/api/chat');
  const modelEl = findValue(['model','modelSelect'], 'gpt-5');
  const tokenEl = findValue(['client','clientToken','client-token'], '');
  const streamEl = findToggle(['stream','streamToggle'], true);
  const sseEl    = findToggle(['sse','expectSSE','sseToggle'], true);
  const resetEl  = $('#reset') || $('#resetSession') || $('.reset');

  // Self-test log
  log('UI found:', {
    feed: !!feed, input: !!input, sendBtn: !!sendBtn, form: !!form,
    apiCtrl: !!apiEl, modelCtrl: !!modelEl, tokenCtrl: !!tokenEl,
    streamCtrl: !!streamEl, sseCtrl: !!sseEl
  });

  if (!input) { err('No input element detected — add #composer or a <textarea>.'); return; }
  if (!sendBtn) warn('No explicit Send button detected — Enter will still submit.');

  function getInputText() {
    if ('value' in input) return (input.value || '').trim();
    if (input.isContentEditable) return (input.textContent || '').trim();
    return '';
  }
  function clearInput() {
    if ('value' in input) input.value = '';
    else if (input.isContentEditable) input.textContent = '';
  }
  function cfg() {
    const api   = (apiEl?.value || 'https://api.keilani.ai/api/chat').trim();
    const model = (modelEl?.value || 'gpt-5').trim();
    const token = (tokenEl?.value || '').trim();
    const uiStream  = !!(streamEl?.checked ?? true);
    const expectSSE = !!(sseEl?.checked ?? true);
    // If Expect SSE is OFF, force stream:false
    const stream = expectSSE ? uiStream : false;
    return { api, model, token, stream, expectSSE };
  }

  // Welcome bubble if empty
  if (!feed.children.length) {
    bubble(feed, 'assistant',
`Hi! I'm here and working. What can I help you with today?

• Ask a quick question
• Summarize a paragraph
• Generate a short code snippet
• Translate a sentence`);
  }

  // ---------- send ----------
  let sending = false;
  async function sendMessage(e) {
    if (e) e.preventDefault();
    if (sending) return;

    const text = getInputText();
    if (!text) return;

    const { api, model, token, stream, expectSSE } = cfg();

    bubble(feed, 'user', text);
    const assistantBody = bubble(feed, 'assistant', '…');
    clearInput();
    sending = true;

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const body = JSON.stringify({
      model,
      stream,                       // forced false if Expect SSE is off
      message: text,                // edge function path
      messages: [{ role: 'user', content: text }], // OpenAI-style path
    });

    log('POST', api, { stream, expectSSE });

    let resp;
    try {
      resp = await fetch(api, { method: 'POST', headers, body });
    } catch (ex) {
      sending = false;
      assistantBody.textContent = `⚠️ Network error: ${ex?.message || ex}`;
      return;
    }

    if (!resp.ok) {
      sending = false;
      let t = '';
      try { t = await resp.text(); } catch {}
      assistantBody.textContent = `⚠️ HTTP ${resp.status}${t ? ` – ${t}` : ''}`;
      return;
    }

    try {
      if (stream && expectSSE && resp.headers.get('content-type')?.includes('text/event-stream')) {
        assistantBody.textContent = '';
        await readSSE(resp.body, (evt) => {
          if (evt.type === 'chunk') {
            assistantBody.textContent += evt.data;
            feed.scrollTop = feed.scrollHeight;
          }
        });
      } else {
        const txt = await parseJSON(resp);
        assistantBody.textContent = txt;
      }
    } catch (ex) {
      assistantBody.textContent = `⚠️ Parse error: ${ex?.message || ex}`;
    } finally {
      sending = false;
    }
  }

  // ---------- wire events (all the ways) ----------
  // Enter to send; Shift+Enter for newline
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Button click
  sendBtn?.addEventListener('click', sendMessage);

  // Form submit (if there is one)
  const usedForm = findForm(input, sendBtn);
  usedForm?.addEventListener('submit', sendMessage);

  // Document fallback (if focus elsewhere and user presses Enter)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement === document.body) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Optional: reset clears feed
  resetEl?.addEventListener('click', (e) => {
    e.preventDefault();
    feed.innerHTML = '';
  });

  // Persist basic fields
  const persist = (k, el, isCheck = false) => {
    const key = `chat:${k}`;
    try {
      if (isCheck) {
        const v = localStorage.getItem(key);
        if (v !== null) el.checked = v === '1';
        el.addEventListener('change', () => localStorage.setItem(key, el.checked ? '1' : '0'));
      } else {
        const v = localStorage.getItem(key);
        if (v !== null) el.value = v;
        const save = () => localStorage.setItem(key, el.value || '');
        el.addEventListener('change', save);
        el.addEventListener('blur', save);
      }
    } catch { /* storage not critical */ }
  };
  persist('api',   apiEl);
  persist('model', modelEl);
  persist('token', tokenEl);
  persist('stream', streamEl, true);
  persist('sse',    sseEl, true);
})();
