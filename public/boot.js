// /public/boot.js
import { streamChat } from '/js/keilaniStream.v24.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Ensure we always have a valid Supabase session (anonymous is OK)
async function ensureSession() {
  const { data } = await supa.auth.getSession();
  if (data?.session) return data.session;

  // Anonymous sign-in must be enabled in Supabase Auth settings (Providers → Anonymous)
  const { data: anon, error } = await supa.auth.signInAnonymously();
  if (error) {
    console.error('Anonymous auth failed:', error);
    throw new Error('Auth required');
  }
  return anon.session;
}

async function getAuthHeader() {
  const session = (await supa.auth.getSession())?.data?.session || (await ensureSession());
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function saveMessage({ role, content }) {
  const session = (await supa.auth.getSession())?.data?.session || (await ensureSession());
  const uid = session?.user?.id;
  if (!uid) return;

  await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...(await getAuthHeader()),
    },
    body: JSON.stringify([{ user_id: uid, role, content }]),
  }).catch(() => {});
}

// ----- UI scaffold -----
const widget = document.getElementById('widget');
widget.innerHTML = `
  <div id="chat" class="chat" aria-live="polite" aria-busy="false"></div>
  <form id="composer" class="composer" autocomplete="off">
    <textarea name="message" rows="1" placeholder="Say hi to Keilani…" required></textarea>
    <button type="submit">Send</button>
    <button type="button" id="stop" title="Stop streaming" aria-label="Stop">Stop</button>
    <span id="typing" style="display:none;margin-left:.5rem;opacity:.7;">Keilani is thinking…</span>
  </form>
`;

const chat = document.getElementById('chat');
const form = document.getElementById('composer');
const input = form.querySelector('textarea[name="message"]');
const typing = document.getElementById('typing');
const stopBtn = document.getElementById('stop');

let currentAssistantTextEl = null;
let currentAbort = null;
let currentBuffer = "";
let marked = null;
let DOMPurify = null;

// Markdown libs (on-demand)
async function ensureMarkdownLibs() {
  if (marked && DOMPurify) return;
  const [{ marked: mkd }, purifier] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js'),
    import('https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.es.js')
  ]);
  marked = mkd;
  DOMPurify = purifier.default;
}

function newBubble(role) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const roleEl = document.createElement('div');
  roleEl.className = 'msg-role';
  roleEl.textContent = role === 'user' ? 'You' : 'Keilani';
  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  bubble.appendChild(roleEl);
  bubble.appendChild(textEl);
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  return textEl;
}

function appendUser(text) {
  const t = newBubble('user');
  t.textContent = text;
  scrollToBottom();
}

function beginAssistant() {
  currentAssistantTextEl = newBubble('assistant');
  currentBuffer = "";
  scrollToBottom();
}

function appendAssistantDelta(delta) {
  if (!currentAssistantTextEl) beginAssistant();
  currentBuffer += delta;
  currentAssistantTextEl.textContent += delta;
  scrollToBottom();
}

async function finalizeAssistantMessage() {
  if (!currentAssistantTextEl) return;
  try {
    await ensureMarkdownLibs();
    const raw = currentBuffer || currentAssistantTextEl.textContent || "";
    const html = marked.parse(raw, { mangle: false, headerIds: false });
    const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    currentAssistantTextEl.innerHTML = clean;
  } catch (_) {
    // keep plain text if libs fail
  } finally {
    await saveMessage({ role: 'assistant', content: currentBuffer });
    currentAssistantTextEl = null;
    currentBuffer = "";
  }
}

function setTyping(on) {
  typing.style.display = on ? 'inline' : 'none';
  chat.setAttribute('aria-busy', on ? 'true' : 'false');
}

function setFormEnabled(on) {
  form.querySelector('button[type="submit"]').disabled = !on;
  input.disabled = !on;
  stopBtn.disabled = on;
}

function scrollToBottom() {
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 50;
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

// Enter to send, Shift+Enter newline
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// Auto-grow textarea
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
});

stopBtn.addEventListener('click', () => {
  if (currentAbort) currentAbort.abort();
});

// Ensure we have a session ASAP (pre-warm token)
ensureSession().catch(console.error);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = (input.value || '').trim();
  if (!message) return;

  appendUser(message);
  await saveMessage({ role: 'user', content: message });

  input.value = '';
  setTyping(true);
  setFormEnabled(false);

  currentAbort = new AbortController();

  try {
    await streamChat({
      message,
      userId: 'webapp',
      agent: 'keilani',
      signal: currentAbort.signal,
      getExtraHeaders: getAuthHeader,
      onTelemetry: () => setTyping(true),
      onHeartbeat: () => setTyping(true),
      onToken: (delta) => appendAssistantDelta(delta),
      onDone: async () => {
        setTyping(false);
        await finalizeAssistantMessage();
      }
    });
  } catch (err) {
    beginAssistant();
    appendAssistantDelta(err?.message === 'Heartbeat timeout'
      ? '\nConnection paused. Reopen chat or try again.'
      : '\nSorry, my connection hiccuped. Please try again.');
    console.error(err);
  } finally {
    setTyping(false);
    setFormEnabled(true);
    currentAbort = null;
  }
});
