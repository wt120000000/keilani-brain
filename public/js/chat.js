/* Keilani Chat – resilient client v3.2
 * - Guaranteed submit: form submit + button click + Enter
 * - If Expect SSE = OFF => force stream:false (JSON path)
 * - Robust SSE/JSON parsing
 */

(() => {
  // ---------------- DOM helpers ----------------
  const $ = (sel) => document.querySelector(sel);
  const byId = (id) => document.getElementById(id);
  const pick = (...ids) => {
    for (const id of ids) {
      if (!id) continue;
      const el =
        byId(id) ||
        document.querySelector(`#${id}`) ||
        document.querySelector(`[name="${id}"]`) ||
        document.querySelector(`[data-id="${id}"]`) ||
        document.querySelector(`.${id}`);
      if (el) return el;
    }
    return null;
  };

  // Expected IDs/classes in your chat.html
  const feed     = pick('feed','messages','chat-feed');
  const input    = pick('composer','input','prompt','message','chat-input');
  const form     = $('form#chat') || input?.closest('form') || $('form');
  const sendBtn  = pick('send','sendBtn','chat-send');
  const apiEl    = pick('api','endpoint','api-url');
  const modelEl  = pick('model','modelSelect');
  const tokenEl  = pick('client','clientToken','client-token');
  const streamEl = pick('stream','streamToggle');
  const sseEl    = pick('sse','expectSSE','sseToggle');
  const resetEl  = pick('reset','resetSession');

  if (!feed)  { console.error('[chat.js] Missing #feed container'); return; }
  if (!input) { console.error('[chat.js] Missing #composer / input'); return; }

  const nowISO = () => new Date().toISOString().replace('T',' ').slice(0,19);

  function bubble(role, text, {asHTML=false, meta=true} = {}) {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.dataset.role = role;

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? 'You' : 'Keilani';

    const body = document.createElement('div');
    body.className = 'content';
    if (asHTML) body.innerHTML = text; else body.textContent = text ?? '';

    msg.appendChild(who);
    msg.appendChild(body);

    if (meta) {
      const ts = document.createElement('div');
      ts.className = 'meta';
      ts.textContent = nowISO();
      msg.appendChild(ts);
    }

    feed.appendChild(msg);
    feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    return body; // return content node for streaming updates
  }

  function showError(text) {
    bubble('assistant', `⚠️ ${text}`);
  }

  function getInputText() {
    // Support textarea or contenteditable fallback
    if (typeof input.value === 'string') return (input.value || '').trim();
    if (input.isContentEditable) return (input.textContent || '').trim();
    return '';
  }

  function clearInput() {
    if (typeof input.value === 'string') input.value = '';
    else if (input.isContentEditable) input.textContent = '';
  }

  function getConfig() {
    const api   = (apiEl?.value || 'https://api.keilani.ai/api/chat').trim();
    const model = (modelEl?.value || 'gpt-5').trim();
    const token = (tokenEl?.value || '').trim();
    const uiStream   = !!(streamEl?.checked ?? true);
    const expectSSE  = !!(sseEl?.checked ?? true);

    // IMPORTANT: if Expect SSE is OFF, force non-stream request
    const stream = expectSSE ? uiStream : false;

    return { api, model, token, stream, expectSSE };
  }

  // ---------------- SSE reader ----------------
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
            obj?.delta ??
            obj?.content ??
            obj?.text ??
            obj?.message ??
            '';

          if (typeof delta !== 'string') delta = String(delta || '');
          if (delta) push(delta);

          if (obj?.error) onEvent?.({ type: 'error', data: obj.error });
        } catch {
          // plain text streaming
          push(payload);
        }
      }
    }

    onEvent?.({ type: 'done', final: finalText });
  }

  // ---------------- JSON path ----------------
  async function parseJSONResponse(resp) {
    const text = await resp.text(); // tolerate wrong content-type
    try {
      const data = JSON.parse(text);

      const finalText =
        data?.output_text ??
        data?.message ??
        data?.response ??
        data?.output ??
        data?.content ??
        data?.text ??
        data?.choices?.[0]?.message?.content ??
        data?.choices?.[0]?.delta?.content ??
        '';

      if (typeof finalText === 'string' && finalText.length) return finalText;
      return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    } catch {
      // not JSON – treat as plain text
      return text;
    }
  }

  // ---------------- SEND ----------------
  let sending = false;
  async function sendMessage(ev) {
    if (ev) ev.preventDefault();
    if (sending) return;

    const msg = getInputText();
    if (!msg) return;

    const { api, model, token, stream, expectSSE } = getConfig();

    // render user + assistant placeholder
    bubble('user', msg);
    clearInput();
    const assistantBody = bubble('assistant', '…', { meta: true });

    sending = true;

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Do NOT include temperature for gpt-5
    const payload = {
      model,
      stream, // already forced false if expectSSE is off
      message: msg,
      messages: [{ role: 'user', content: msg }],
    };

    let resp;
    try {
      resp = await fetch(api, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (e) {
      sending = false;
      assistantBody.textContent = `⚠️ Network error: ${e?.message || e}`;
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
      if (stream && expectSSE) {
        assistantBody.textContent = '';
        await readSSE(resp.body, (evt) => {
          if (evt.type === 'chunk') {
            assistantBody.textContent += evt.data;
            feed.scrollTop = feed.scrollHeight;
          }
        });
      } else {
        const txt = await parseJSONResponse(resp);
        assistantBody.textContent = txt;
      }
    } catch (e) {
      assistantBody.textContent = `⚠️ Parse error: ${e?.message || e}`;
    } finally {
      sending = false;
    }
  }

  // ---------------- WIRING ----------------
  function wireSubmitHandlers() {
    // Enter on textarea/contenteditable
    input.addEventListener('keydown', (e) => {
      const isEnter = e.key === 'Enter';
      const isShift = e.shiftKey;
      if (isEnter && !isShift) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Send button
    sendBtn?.addEventListener('click', sendMessage);

    // Form submit (covers button + Enter in some browsers)
    form?.addEventListener('submit', sendMessage);

    // Document-level fallback (if focus is elsewhere)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (document.activeElement === document.body)) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Reset session just clears UI
    resetEl?.addEventListener('click', (e) => {
      e.preventDefault();
      feed.innerHTML = '';
      welcome();
    });
  }

  function welcome() {
    bubble('assistant',
`Hi! I’m here and working. What can I help you with today?

• Ask a quick question
• Summarize a paragraph
• Generate a short code snippet
• Translate a sentence`);
  }

  function restorePersisted() {
    const ls = (k,v) => (v===undefined ? localStorage.getItem(k) : localStorage.setItem(k,v));
    const fields = [
      ['api', apiEl],
      ['model', modelEl],
      ['client', tokenEl],
      ['stream', streamEl, 'checkbox'],
      ['sse', sseEl, 'checkbox'],
    ];
    for (const [key, el, type] of fields) {
      if (!el) continue;
      const lsKey = `chat:${key}`;
      if (type === 'checkbox') {
        const v = ls(lsKey);
        if (v !== null) el.checked = v === '1';
        el.addEventListener('change', () => ls(lsKey, el.checked ? '1' : '0'));
      } else {
        const v = ls(lsKey);
        if (v !== null) el.value = v;
        const save = () => ls(lsKey, el.value || '');
        el.addEventListener('change', save);
        el.addEventListener('blur', save);
      }
    }
  }

  function init() {
    restorePersisted();
    wireSubmitHandlers();
    if (!feed.children.length) welcome();
  }

  // Wait for DOM if needed
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
