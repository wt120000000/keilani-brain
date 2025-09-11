/* Keilani Chat UI — CSP-safe, streaming + SSE, resilient feed creation */

(() => {
  // ---------- Utilities ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const store = {
    get k() { return 'keilani.chat.v1'; },
    read() {
      try { return JSON.parse(localStorage.getItem(this.k) || '{}'); } catch { return {}; }
    },
    write(obj) { localStorage.setItem(this.k, JSON.stringify(obj || {})); }
  };

  // Ensure feed exists even if HTML changes
  function ensureFeed() {
    let feed = $('#feed');
    if (!feed) {
      feed = document.createElement('div');
      feed.id = 'feed';
      feed.className = 'feed';
      const composer = $('#composer');
      const main = $('#main') || document.body;
      if (composer && composer.parentNode) composer.parentNode.insertBefore(feed, composer);
      else main.prepend(feed);
    }
    return feed;
  }

  // ---------- DOM refs ----------
  const modelSel   = $('#model');
  const apiInput   = $('#api');
  const tokenInput = $('#token');
  const saveBtn    = $('#save');
  const exportBtn  = $('#export');
  const clearBtn   = $('#clear');
  const resetBtn   = $('#reset');
  const streamCk   = $('#stream');
  const sseCk      = $('#sse');
  const tokenBadge = $('#tokencounter');
  const sidBadge   = $('#sid');
  const rawBtn     = $('#inspector');
  const rawPre     = $('#raw');
  const promptEl   = $('#prompt');
  const sendBtn    = $('#send');

  let FEED = ensureFeed();

  // ---------- State ----------
  let sessionId = shortId();
  let messages = [];
  let tokens = 0;

  function shortId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function loadConfig() {
    const s = store.read();
    if (s.model)  modelSel.value = s.model;
    if (s.api)    apiInput.value = s.api;
    if (s.token)  tokenInput.value = s.token;
    if (typeof s.stream === 'boolean') streamCk.checked = s.stream;
    if (typeof s.sse === 'boolean')    sseCk.checked = s.sse;
    if (s.sessionId) sessionId = s.sessionId;
    sidBadge.textContent = `SID: ${sessionId}`;
  }

  function saveConfig() {
    store.write({
      model: modelSel.value.trim(),
      api: apiInput.value.trim(),
      token: tokenInput.value,
      stream: !!streamCk.checked,
      sse: !!sseCk.checked,
      sessionId
    });
  }

  // ---------- Rendering ----------
  function bubble(role, html, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role === 'user' ? 'me' : role}`;
    const b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = html;
    wrap.appendChild(b);
    (FEED || ensureFeed()).appendChild(wrap);
    FEED.scrollTop = FEED.scrollHeight;
    if (opts.codeHighlight) {
      try { hljs.highlightAll(); } catch {}
    }
  }

  function showError(text) {
    bubble('error', escapeHtml(text));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function renderUser(text) {
    const md = window.marked?.marked || ((t)=>escapeHtml(t));
    bubble('user', md.parse(text));
  }

  function renderAssistantChunk(chunk) {
    // Append to a streaming block (last assistant bubble) or create one
    let last = FEED.lastElementChild;
    const isAssistant = last && last.classList.contains('assistant');
    if (!isAssistant) {
      last = document.createElement('div');
      last.className = 'msg assistant';
      const b = document.createElement('div');
      b.className = 'bubble';
      last.appendChild(b);
      FEED.appendChild(last);
    }
    const bubbleEl = last.querySelector('.bubble');
    bubbleEl.insertAdjacentText('beforeend', chunk);
    FEED.scrollTop = FEED.scrollHeight;
  }

  function renderAssistantFinal(text) {
    const md = window.marked?.marked || ((t)=>escapeHtml(t));
    // Replace the last assistant bubble with parsed markdown
    let last = FEED.lastElementChild;
    const isAssistant = last && last.classList.contains('assistant');
    if (!isAssistant) {
      const wrap = document.createElement('div');
      wrap.className = 'msg assistant';
      wrap.innerHTML = `<div class="bubble"></div>`;
      FEED.appendChild(wrap);
      last = wrap;
    }
    const bubbleEl = last.querySelector('.bubble');
    bubbleEl.innerHTML = md.parse(text);
    // highlight code
    try { hljs.highlightAll(); } catch {}
  }

  function setTokens(count, rate) {
    tokens = count;
    tokenBadge.textContent = `Tokens: ${count} • ${rate ?? 0}/s`;
  }

  // ---------- Network ----------
  async function sendMessage() {
    FEED = ensureFeed();

    const api = apiInput.value.trim() || 'https://api.keilani.ai/api/chat';
    const model = modelSel.value.trim();
    const stream = !!streamCk.checked;
    const expectSSE = !!sseCk.checked;
    const token = tokenInput.value || undefined;

    const text = promptEl.value.trim();
    if (!text) return;

    // UI: render user bubble immediately
    renderUser(text);

    // keep history for messages API
    messages.push({ role: 'user', content: text });

    // Clear prompt + focus
    promptEl.value = '';
    promptEl.focus();

    // request payload uses messages[] (server also supports single message)
    const payload = {
      model,
      stream,
      session_id: sessionId,
      messages
    };

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Client-Token'] = token;

    let res;
    try {
      res = await fetch(api, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
    } catch (err) {
      showError(`Network error: ${err.message || err}`);
      return;
    }

    // Capture raw (for inspector)
    rawPre.textContent = ''; // reset
    const isSSE = expectSSE && res.headers.get('content-type')?.includes('text/event-stream');

    if (!res.ok && !isSSE) {
      let errText = '';
      try { errText = await res.text(); } catch {}
      showError(`[Error] HTTP ${res.status}${errText ? ' – ' + errText : ''}`);
      return;
    }

    if (stream && isSSE) {
      // ---------- SSE path ----------
      try {
        await readSSE(res.body, (evt) => {
          if (evt.type === 'chunk') {
            renderAssistantChunk(evt.data);
          } else if (evt.type === 'done') {
            if (evt.final) {
              renderAssistantFinal(evt.final);
              messages.push({ role: 'assistant', content: evt.final });
            }
          } else if (evt.type === 'error') {
            showError(evt.data || 'SSE error');
          } else if (evt.type === 'raw') {
            rawPre.textContent += evt.data;
          } else if (evt.type === 'stats') {
            setTokens(evt.tokens ?? tokens, evt.rate ?? 0);
          }
        });
      } catch (e) {
        showError(`SSE read error: ${e.message || e}`);
      }
    } else {
      // ---------- JSON path ----------
      let data = null;
      try { data = await res.json(); }
      catch (e) {
        const txt = await res.text().catch(()=> '');
        showError(`Invalid JSON response${txt ? ' – ' + txt.slice(0,200) : ''}`);
        return;
      }
      rawPre.textContent = JSON.stringify(data, null, 2);

      const finalText = (data?.output_text) || (data?.message) || (data?.choices?.[0]?.message?.content) || '';
      if (finalText) {
        renderAssistantFinal(finalText);
        messages.push({ role: 'assistant', content: finalText });
      } else {
        showError('No assistant text in response.');
      }

      const t = Number(data?.usage?.total_tokens) || tokens;
      setTokens(t);
    }
  }

  // Basic SSE reader for event-stream bodies
  async function readSSE(stream, onEvent) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      onEvent?.({ type: 'raw', data: chunk });

      // Parse by lines
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') {
            onEvent?.({ type: 'done', final: finalText });
            return;
          }
          try {
            const obj = JSON.parse(dataStr);
            if (typeof obj.delta === 'string') {
              finalText += obj.delta;
              onEvent?.({ type: 'chunk', data: obj.delta });
            }
            if (obj.tokens || obj.rate) {
              onEvent?.({ type: 'stats', tokens: obj.tokens, rate: obj.rate });
            }
            if (obj.error) {
              onEvent?.({ type: 'error', data: obj.error });
            }
          } catch {
            // Some servers stream plain text chunks
            finalText += dataStr;
            onEvent?.({ type: 'chunk', data: dataStr });
          }
        }
      }
    }
    onEvent?.({ type: 'done', final: finalText });
  }

  // ---------- Actions ----------
  function clearChat() {
    messages = [];
    (FEED || ensureFeed()).innerHTML = '';
    setTokens(0, 0);
    rawPre.textContent = '';
  }

  function resetSession() {
    clearChat();
    sessionId = shortId();
    sidBadge.textContent = `SID: ${sessionId}`;
    saveConfig();
  }

  function exportTxt() {
    let txt = '';
    $$('#feed .msg').forEach(msg => {
      const isUser = msg.classList.contains('me');
      const role = isUser ? 'You' : (msg.classList.contains('assistant') ? 'Keilani' : 'System');
      const content = msg.querySelector('.bubble')?.innerText || '';
      txt += `${role}:\n${content}\n\n`;
    });
    const blob = new Blob([txt], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `keilani_chat_${sessionId}.txt` });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function toggleInspector() {
    rawPre.classList.toggle('hidden');
  }

  // ---------- Events ----------
  function bindEvents() {
    saveBtn.addEventListener('click', saveConfig);
    exportBtn.addEventListener('click', exportTxt);
    clearBtn.addEventListener('click', clearChat);
    resetBtn.addEventListener('click', resetSession);
    rawBtn.addEventListener('click', toggleInspector);

    // Enter to send; Shift+Enter newline
    promptEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    sendBtn.addEventListener('click', sendMessage);
  }

  // ---------- Init ----------
  function boot() {
    ensureFeed();
    loadConfig();
    bindEvents();
    // First-time welcome
    if (FEED.childElementCount === 0) {
      bubble('assistant', `
        <b>Hi! I’m here and working.</b> What can I help you with?
        <ul>
          <li>Ask a quick question</li>
          <li>Summarize a paragraph</li>
          <li>Generate a short code snippet</li>
          <li>Translate a sentence</li>
        </ul>
      `, { codeHighlight: false });
    }
  }

  boot();
})();
