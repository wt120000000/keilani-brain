/* Keilani chat client — ultra-tolerant v3.4
   - Capture-phase listeners (document level) so clicks/keys can't be swallowed
   - Rebind on DOM changes (MutationObserver)
   - Global window.__send() for manual trigger
   - Streams only if "Expect SSE" is ON; otherwise JSON
*/
(() => {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const log  = (...a)=>console.log('[chat.js]', ...a);
  const warn = (...a)=>console.warn('[chat.js]', ...a);
  const err  = (...a)=>console.error('[chat.js]', ...a);

  // -------- find/create UI --------
  function ensureFeed() {
    let el = $('#feed') || $('.feed') || $('#messages') || $('.messages');
    if (!el) {
      el = document.createElement('div');
      el.id = 'feed';
      el.style.cssText = 'max-height:48vh;overflow:auto;padding:.75rem;border-radius:.75rem;border:1px solid rgba(255,255,255,.08);margin:.75rem 0;';
      const host = $('main') || $('form') || document.body;
      host.insertBefore(el, host.firstChild);
    }
    return el;
  }
  function findInput() {
    return (
      $('#composer') || $('.composer') ||
      $('#prompt')   || $('.prompt')   ||
      $('#message')  || $('.message')  ||
      $('textarea')  || $('[contenteditable="true"]')
    );
  }
  function findSend() {
    let b = $('#send') || $('.send') || $('#sendBtn') || $('button[type="submit"]');
    if (b) return b;
    for (const btn of $$('button')) {
      const t = (btn.textContent||'').trim().toLowerCase();
      if (t === 'send' || t.startsWith('send')) return btn;
    }
    return null;
  }
  function findValue(cands, def='') {
    for (const id of cands) {
      const el = document.getElementById(id) || document.querySelector(`#${id}, .${id}, [name="${id}"]`);
      if (el && 'value' in el) return el;
    }
    const tmp = document.createElement('input'); tmp.value = def; return tmp;
  }
  function findToggle(cands, def=true) {
    for (const id of cands) {
      const el = document.getElementById(id) || document.querySelector(`#${id}, .${id}, [name="${id}"]`);
      if (el && 'checked' in el) return el;
    }
    const fake = document.createElement('input'); fake.type='checkbox'; fake.checked=def; return fake;
  }

  // -------- bubbles --------
  function bubble(feed, role, text, {asHTML=false}={}) {
    const wrap = document.createElement('div');
    wrap.style.cssText='margin:.5rem 0;';
    const head = document.createElement('div');
    head.style.cssText='opacity:.7;font-size:.85rem;margin-bottom:.25rem;';
    head.textContent = role==='user'?'You':'Keilani';
    const body = document.createElement('div');
    body.style.cssText='white-space:pre-wrap;line-height:1.5;border:1px solid rgba(255,255,255,.08);padding:.75rem;border-radius:.6rem;';
    if (asHTML) body.innerHTML = text||''; else body.textContent=text||'';
    wrap.append(head, body);
    feed.appendChild(wrap);
    feed.scrollTop = feed.scrollHeight;
    return body;
  }

  async function readSSE(stream, onEvent) {
    const reader = stream.getReader();
    const dec = new TextDecoder(); let buf=''; let full='';
    const push = (s)=>{ if(!s) return; full+=s; onEvent?.({type:'chunk', data:s}); };
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream:true});
      const lines = buf.split(/\r?\n/); buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (/^\[?done\]?$/i.test(payload) || payload === '__END__') { onEvent?.({type:'done', final:full}); return; }
        try {
          const obj = JSON.parse(payload);
          let d = obj?.choices?.[0]?.delta?.content ?? obj?.delta ?? obj?.content ?? obj?.text ?? obj?.message ?? '';
          if (typeof d !== 'string') d = String(d||'');
          push(d);
          if (obj?.error) onEvent?.({type:'error', data: obj.error});
        } catch { push(payload); }
      }
    }
    onEvent?.({type:'done', final:full});
  }
  async function parseJSON(resp) {
    const t = await resp.text();
    try {
      const j = JSON.parse(t);
      return (
        j?.output_text ??
        j?.message ??
        j?.response ??
        j?.output ??
        j?.content ??
        j?.text ??
        j?.choices?.[0]?.message?.content ??
        j?.choices?.[0]?.delta?.content ??
        (typeof j === 'string' ? j : JSON.stringify(j, null, 2))
      );
    } catch { return t; }
  }

  const feed = ensureFeed();
  let input = findInput();
  let sendBtn = findSend();
  const apiEl   = findValue(['api','endpoint','api-url'], 'https://api.keilani.ai/api/chat');
  const modelEl = findValue(['model','modelSelect'], 'gpt-5');
  const tokenEl = findValue(['client','clientToken','client-token'], '');
  const streamEl= findToggle(['stream','streamToggle'], true);
  const sseEl   = findToggle(['sse','expectSSE','sseToggle'], true);

  log('UI found:', { feed: !!feed, input: !!input, sendBtn: !!sendBtn, form:false, apiCtrl: !!apiEl, modelCtrl: !!modelEl, tokenCtrl: !!tokenEl, streamCtrl: !!streamEl, sseCtrl: !!sseEl });

  if (!feed.children.length) {
    bubble(feed, 'assistant',
`Hi! I'm here and working. What can I help you with today?

• Ask a quick question
• Summarize a paragraph
• Generate a short code snippet
• Translate a sentence`);
  }

  const getText = () => input && ('value' in input ? input.value.trim() : (input.textContent||'').trim());
  const clearInput = () => { if (!input) return; if ('value' in input) input.value=''; else input.textContent=''; };
  const cfg = () => {
    const api   = (apiEl?.value || 'https://api.keilani.ai/api/chat').trim();
    const model = (modelEl?.value || 'gpt-5').trim();
    const token = (tokenEl?.value || '').trim();
    const expectSSE = !!(sseEl?.checked ?? true);
    let stream = !!(streamEl?.checked ?? true);
    if (!expectSSE) stream = false;
    return { api, model, token, stream, expectSSE };
  };

  let sending = false;
  async function sendMessage() {
    if (sending) return;
    const text = getText();
    if (!text) return;

    const { api, model, token, stream, expectSSE } = cfg();
    bubble(feed, 'user', text);
    const assist = bubble(feed, 'assistant', '…');

    clearInput();
    sending = true;

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const body = JSON.stringify({
      model,
      stream,                         // false if Expect SSE is off
      message: text,                  // Netlify edge-style
      messages: [{ role:'user', content:text }], // OpenAI style
    });

    log('POST', api, { stream, expectSSE });
    let resp;
    try {
      resp = await fetch(api, { method:'POST', headers, body });
    } catch (ex) {
      assist.textContent = `⚠️ Network error: ${ex?.message || ex}`;
      sending = false; return;
    }
    if (!resp.ok) {
      let t=''; try { t = await resp.text(); } catch {}
      assist.textContent = `⚠️ HTTP ${resp.status}${t ? ` – ${t}`: ''}`;
      sending = false; return;
    }

    try {
      const ct = resp.headers.get('content-type') || '';
      if (stream && expectSSE && ct.includes('text/event-stream') && resp.body) {
        assist.textContent = '';
        await readSSE(resp.body, (ev) => {
          if (ev.type === 'chunk') { assist.textContent += ev.data; feed.scrollTop = feed.scrollHeight; }
        });
      } else {
        const txt = await parseJSON(resp);
        assist.textContent = txt;
      }
    } catch (ex) {
      assist.textContent = `⚠️ Parse error: ${ex?.message || ex}`;
    } finally {
      sending = false;
    }
  }

  // expose for console
  window.__send = sendMessage;

  // -------- capture-phase wiring so nothing can swallow the events --------
  // Enter (without Shift) sends
  const keyHandler = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (document.activeElement === input || document.activeElement === document.body) {
        log('keydown Enter -> send');
        e.preventDefault();
        sendMessage();
      }
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  // Button click (any click inside the send button)
  const clickHandler = (e) => {
    if (!sendBtn) return;
    if (sendBtn.contains(e.target)) {
      log('click send button -> send');
      e.preventDefault();
      sendMessage();
    }
  };
  document.addEventListener('click', clickHandler, true);

  // In case the app swaps the DOM after hydration, re-find nodes & keep listeners valid
  const mo = new MutationObserver(() => {
    const newInput = findInput();
    const newSend  = findSend();
    if (newInput !== input) { input = newInput; log('rebuilt: input', !!input); }
    if (newSend  !== sendBtn){ sendBtn = newSend;  log('rebuilt: sendBtn', !!sendBtn); }
  });
  mo.observe(document.documentElement, { subtree:true, childList:true });

  // Small help log
  log('Ready. Tip: call window.__send() in console to force a send.');
})();
