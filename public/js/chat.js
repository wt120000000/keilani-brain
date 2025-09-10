// public/js/chat.js

// ----- Marked / highlight shims (UMD-safe) -----
const getMarked = () => {
  const m = window.marked;
  if (!m) return null;
  if (typeof m.parse === "function") return m;           // v12 UMD
  if (typeof m === "function") return { parse: m, setOptions: () => {} }; // legacy
  return null;
};
const _marked = getMarked();
if (_marked && window.hljs) {
  _marked.setOptions?.({
    highlight: (code, lang) => {
      const l = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language: l }).value;
    },
  });
}
const escapeHtml = (s = "") =>
  String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const renderMarkdown = (text) => {
  const m = getMarked();
  if (!m) return escapeHtml(text);
  try { return m.parse(String(text ?? "")); } catch { return escapeHtml(text); }
};

// ----- DOM -----
const model    = document.querySelector('#model');
const api      = document.querySelector('#api');
const token    = document.querySelector('#token');
const stream   = document.querySelector('#stream');
const sse      = document.querySelector('#sse');
const sendBtn  = document.querySelector('#send');
const composer = document.querySelector('#composer');
const list     = document.querySelector('#list');
const saveBtn  = document.querySelector('#save');
const exportBtn= document.querySelector('#export');
const clearBtn = document.querySelector('#clear');
const resetBtn = document.querySelector('#reset');
const rawBtn   = document.querySelector('#raw');
const errorBox = document.querySelector('#error');
const sidEl    = document.querySelector('#sid');

// ----- State -----
let messages = [];
let sid = Math.random().toString(16).slice(2, 10);
sidEl.textContent = sid;

// hydrate
(() => {
  const st = JSON.parse(localStorage.getItem('kln.chat.cfg') || '{}');
  if (st.model) model.value = st.model;
  api.value   = st.api || 'https://api.keilani.ai/api/chat';
  if (st.token) token.value = st.token;
  stream.checked = st.stream ?? true;
  sse.checked    = st.sse ?? true;
})();
function persist() {
  const st = {
    model: model.value,
    api: api.value.trim(),
    token: token.value.trim(),
    stream: !!stream.checked,
    sse: !!sse.checked,
  };
  localStorage.setItem('kln.chat.cfg', JSON.stringify(st));
}
saveBtn.onclick = persist;

clearBtn.onclick = () => {
  messages = [];
  list.innerHTML = '';
  composer.value = '';
  errorBox.hidden = true;
  persist();
};
resetBtn.onclick = () => {
  sid = Math.random().toString(16).slice(2, 10);
  sidEl.textContent = sid;
  messages = [];
  list.innerHTML = '';
  composer.value = '';
  errorBox.hidden = true;
};
exportBtn.onclick = () => {
  const lines = messages.map(m => `[${m.role}] ${m.content}`).join('\n\n');
  const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `chat-${sid}.txt`; a.click();
  URL.revokeObjectURL(url);
};
rawBtn.onclick = () => {
  const raw = {
    cfg: JSON.parse(localStorage.getItem('kln.chat.cfg') || '{}'),
    sid,
    messages
  };
  alert(JSON.stringify(raw, null, 2));
};

// helpers
function addMsg(role, content, render=true) {
  const m = { role, content: String(content ?? '') };
  messages.push(m);
  if (render) renderMsg(m);
}
function renderMsg(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.role}`;
  if (m.role === 'assistant') {
    div.innerHTML = renderMarkdown(m.content);
  } else {
    div.textContent = m.content;
  }
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  if (window.hljs) div.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  return div;
}

// keyboard
composer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); composer.focus();
  }
  if (e.key === 'ArrowUp' && document.activeElement === composer && !composer.value) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        composer.value = messages[i].content;
        messages.splice(i, 1);
        list.removeChild(list.lastElementChild);
        break;
      }
    }
  }
});

// send
sendBtn.onclick = async () => {
  const text = composer.value.trim();
  if (!text) return;
  errorBox.hidden = true;

  addMsg('user', text);
  composer.value = '';

  const cfg = {
    model: model.value,
    stream: !!stream.checked,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };

  sendBtn.disabled = true;
  try {
    if (cfg.stream && sse.checked) await sendSSE(cfg);
    else await sendJSON(cfg);
    persist();
  } catch (err) {
    console.error(err);
    errorBox.hidden = false;
    errorBox.textContent = `[Error] ${String(err.message || err)}`;
  } finally {
    sendBtn.disabled = false;
  }
};

async function sendJSON(cfg) {
  const res = await fetch(api.value.trim(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token.value.trim() ? { 'Authorization': `Bearer ${token.value.trim()}` } : {}),
    },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status} – ${t || res.statusText}`);
  }
  const data = await res.json();
  const reply = data?.reply ?? data?.choices?.[0]?.message?.content ?? '';
  addMsg('assistant', reply);
}

async function sendSSE(cfg) {
  const res = await fetch(api.value.trim(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token.value.trim() ? { 'Authorization': `Bearer ${token.value.trim()}` } : {}),
    },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status} – ${t || res.statusText}`);
  }
  const m = { role: 'assistant', content: '' };
  const bubble = renderMsg(m);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') break;
      try {
        const obj = JSON.parse(payload);
        const token = obj?.choices?.[0]?.delta?.content ?? obj?.delta ?? obj?.token ?? '';
        if (token) {
          m.content += token;
          bubble.innerHTML = renderMarkdown(m.content);
          if (window.hljs) bubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
          list.scrollTop = list.scrollHeight;
        }
      } catch {}
    }
  }
}

// welcome
if (!sessionStorage.getItem('kln.chat.welcomed')) {
  addMsg('assistant',
`Hi! I’m here and working. How can I help today? If you’re testing, you can try:

• Ask a quick question
• Summarize a paragraph
• Generate a short code snippet
• Translate a sentence`);
  sessionStorage.setItem('kln.chat.welcomed','1');
}
