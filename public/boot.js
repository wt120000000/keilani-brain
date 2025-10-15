// /public/boot.js
import { streamChat } from '/js/keilaniStream.v24.js';

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
let currentBuffer = "";       // full assistant text (for markdown re-render)
let marked = null;
let DOMPurify = null;

// Lazy-load MD renderer + sanitizer on first use
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
  currentAssistantTextEl.textContent += delta; // streaming uses textContent (safe)
  scrollToBottom();
}

async function finalizeAssistantMessage() {
  if (!currentAssistantTextEl) return;
  try {
    await ensureMarkdownLibs();
    const raw = currentBuffer || currentAssistantTextEl.textContent || "";
    const html = marked.parse(raw, { mangle: false, headerIds: false });
    const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    currentAssistantTextEl.innerHTML = clean; // safe: sanitized HTML
  } catch (_) {
    // if libs fail for any reason, we keep plain text
  } finally {
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
  stopBtn.disabled = on; // stop is enabled only while streaming
}

function scrollToBottom() {
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 50;
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

// UX: Enter to send, Shift+Enter for newline
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// Auto-grow textarea height
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
});

stopBtn.addEventListener('click', () => {
  if (currentAbort) currentAbort.abort();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = (input.value || '').trim();
  if (!message) return;

  appendUser(message);
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
      onTelemetry: () => setTyping(true),
      onHeartbeat: () => setTyping(true),
      onToken: (delta) => appendAssistantDelta(delta),
      onDone: async () => {
        setTyping(false);
        await finalizeAssistantMessage();
      }
    });
  } catch (err) {
    if (err?.message === 'Heartbeat timeout') {
      beginAssistant();
      appendAssistantDelta('\nConnection paused. Reopen chat or try again.');
    } else {
      beginAssistant();
      appendAssistantDelta('\nSorry, my connection hiccuped. Please try again.');
    }
    console.error(err);
  } finally {
    setTyping(false);
    setFormEnabled(true);
    currentAbort = null;
  }
});
