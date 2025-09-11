/* Keilani Chat – resilient client (SSE + JSON)
 * v3.1
 */

(() => {
  // ---------- DOM helpers (robust selectors) ----------
  const $ = (sel) => document.querySelector(sel);
  const byId = (id) => document.getElementById(id);

  // Try a few known ids/classes to be resilient to HTML changes
  const getEl = (...ids) => {
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

  const feed    = getEl('feed', 'messages', 'chat-feed');
  const input   = getEl('composer', 'input', 'prompt', 'message', 'chat-input');
  const sendBtn = getEl('send', 'sendBtn', 'chat-send');
  const apiEl   = getEl('api', 'endpoint', 'api-url');
  const modelEl = getEl('model', 'modelSelect');
  const tokenEl = getEl('client', 'clientToken', 'client-token');
  const streamEl= getEl('stream', 'streamToggle');
  const sseEl   = getEl('sse', 'expectSSE', 'sseToggle');
  const resetEl = getEl('reset', 'resetSession');
  const saveEl  = getEl('save', 'saveBtn');

  if (!feed || !input) {
    console.error('[chat.js] Missing required DOM nodes. Ensure ids: feed & composer (textarea) exist.');
    return;
  }

  // ---------- Utilities ----------
  const nowISO = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  function bubble(role, text, opts = {}) {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.setAttribute('data-role', role);

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? 'You' : 'Keilani';

    const body = document.createElement('div');
    body.className = 'content';
    body.textContent = ''; // will fill below

    if (opts.asHTML) {
      body.innerHTML = text;
    } else {
      body.textContent = text;
    }

    msg.appendChild(who);
    msg.appendChild(body);

    // Optional small timestamp
    const ts = document.createElement('div');
    ts.className = 'meta';
    ts.textContent = nowISO();
    msg.appendChild(ts);

    feed.appendChild(msg);
    feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    return body; // return the content node for streaming updates
  }

  function showError(err) {
    const text = typeof err === 'string' ? err : (err?.message || 'Unknown error');
    bubble('assistant', `⚠️ ${text}`);
  }

  function getConfig() {
    const api   = (apiEl?.value || 'https://api.keilani.ai/api/chat').trim();
    const model = (modelEl?.value || 'gpt-5').trim();
    const token = (tokenEl?.value || '').trim();
    const stream = !!(streamEl?.checked ?? true);
    const expectSSE = !!(sseEl?.checked ?? true);
    return { api, model, token, stream, expectSSE };
  }

  // ---------- SSE reader (very tolerant) ----------
  async function readSSE(stream, onEvent) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
      buffer += chunk;
      onEvent?.({ type: 'raw', data: chunk });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim().replace(/^\s*/, '');
        if (!payload) continue;

        if (payload === '[DONE]' || payload === '[done]' || payload === '__END__') {
          onEvent?.({ type: 'done', final: finalText });
          return;
        }

        // Try JSON, fall back to plain text
        try {
          const obj = JSON.parse(payload);

          // Extremely flexible "find the text" logic
          let delta =
            // OpenAI chat
            obj?.choices?.[0]?.delta?.content ??
            // OpenAI content array
            (Array.isArray(obj?.choices?.[0]?.delta?.content)
              ? obj.choices[0].delta.content.map(x => x?.text || '').join('')
              : undefined) ??
            // Llama-ish
            obj?.delta ??
            // Anthropic/generic
            obj?.content ??
            obj?.text ??
            obj?.message ??
            '';

          if (typeof delta !== 'string') delta = String(delta || '');
          if (delta) push(delta);

          if (obj.error) onEvent?.({ type: 'error', data: obj.error });
        } catch {
          // plain text streaming
          push(payload);
        }
      }
    }

    onEvent?.({ type: 'done', final: finalText });
  }

  // ---------- JSON (non-SSE) parsing ----------
  async function parseJSONResponse(resp) {
    // Some backends return invalid content-type but still JSON
    let text;
    try {
      text = await resp.text();
    } catch (e) {
      throw new Error(`Failed reading response: ${e?.message || e}`);
    }

    // If not JSON, return the raw text
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Plain text (valid) – just return it
      return text;
    }

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

    // If no obvious field, return prettified JSON to help debugging
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  }

  // ---------- Send logic ----------
  async function sendMessage(e) {
    if (e) e.preventDefault();
    const msg = (input.value || '').trim();
    if (!msg) return;

    const { api, model, token, stream, expectSSE } = getConfig();

    // Render user bubble
    bubble('user', msg);
    input.value = '';
    input.focus();

    // Create placeholder assistant bubble we can stream into
    const assistantBody = bubble('assistant', '');

    const headers = {
      'Content-Type': 'application/json'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Build a tolerant payload; DO NOT include temperature for gpt-5
    const body = {
      model,
      stream: !!stream,
      // server might accept either `message` or `messages`
      message: msg,
      messages: [{ role: 'user', content: msg }]
    };

    let resp;
    try {
      resp = await fetch(api, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      assistantBody.textContent = `⚠️ Network error: ${err?.message || err}`;
      return;
    }

    if (!resp.ok) {
      let errText = `HTTP ${resp.status}`;
      try {
        const t = await resp.text();
        // Try to extract upstream error details if present
        errText += ` – ${t}`;
      } catch { /* ignore */ }
      assistantBody.textContent = `⚠️ ${errText}`;
      return;
    }

    // STREAMING path
    if (stream && expectSSE) {
      try {
        await readSSE(resp.body, (ev) => {
          if (ev.type === 'chunk') {
            assistantBody.textContent += ev.data;
            feed.scrollTo({ top: feed.scrollHeight });
          } else if (ev.type === 'error') {
            assistantBody.textContent += `\n[error] ${ev.data}`;
          }
        });
      } catch (err) {
        assistantBody.textContent += `\n⚠️ Stream error: ${err?.message || err}`;
      }
      return;
    }

    // NON-STREAM (JSON or text) path
    try {
      const finalText = await parseJSONResponse(resp);
      assistantBody.textContent = finalText;
    } catch (err) {
      assistantBody.textContent = `⚠️ Invalid JSON response (try enabling “Expect SSE”): ${err?.message || err}`;
    }
  }

  // ---------- Wire up ----------
  function init() {
    // Enter to send; Shift+Enter for newline
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn?.addEventListener('click', sendMessage);
    resetEl?.addEventListener('click', () => {
      // Simple visual reset
      feed.innerHTML = '';
      bubble('assistant',
        `Hi! I’m here and working. What can I help you with?\n\n• Ask a quick question\n• Summarize a paragraph\n• Generate a short code snippet\n• Translate a sentence`
      );
    });

    // Render a tiny welcome if the feed is empty
    if (!feed.children.length) {
      bubble('assistant',
        `Hi! I’m here and working. What can I help you with?\n\n• Ask a quick question\n• Summarize a paragraph\n• Generate a short code snippet\n• Translate a sentence`
      );
    }

    // Optional: persist a few fields
    const ls = (k, v) => (v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v));
    ['api', 'model', 'client', 'stream', 'sse'].forEach((k) => {
      const el = getEl(k);
      if (!el) return;
      const key = `chat:${k}`;
      // load
      if (el.type === 'checkbox') {
        const v = ls(key);
        if (v !== null) el.checked = v === '1';
        el.addEventListener('change', () => ls(key, el.checked ? '1' : '0'));
      } else {
        const v = ls(key);
        if (v !== null) el.value = v;
        el.addEventListener('change', () => ls(key, el.value || ''));
        el.addEventListener('blur',   () => ls(key, el.value || ''));
      }
    });
  }

  init();
})();
