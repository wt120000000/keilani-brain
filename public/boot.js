// /public/boot.js
import { streamChat } from '/js/keilaniStream.v23.js';

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

let currentAssistantBubble = null;
let currentAbort = null;

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
  t.textContent = text; // SAFE (no HTML injection)
  scrollToBottom();
}

function beginAssistant() {
  currentAssistantBubble = newBubble('assistant');
  scrollToBottom();
}

function appendAssistantDelta(delta) {
  if (!currentAssistantBubble) beginAssistant();
  currentAssistantBubble.textContent += delta; // SAFE (no HTML injection)
  scrollToBottom();
}

function endAssistant() {
  currentAssistantBubble = null;
}

function setTyping(on) {
  typing.style.display = on ? 'inline' : 'none';
  chat.setAttribute('aria-busy', on ? 'true' : 'false');
}

function setFormEnabled(on) {
  form.querySelector('button[type="submit"]').disabled = !on;
  input.disabled = !on;
  stopBtn.disabled = on; // stop is only enabled while streaming
}

function scrollToBottom() {
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 50;
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

stopBtn.addEventListener('click', () => {
  if (currentAbort) {
    currentAbort.abort();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = (input.value || '').trim();
  if (!message) return;

  appendUser(message);
  input.value = '';
  setTyping(true);
  setFormEnabled(false);

  // allow one in-flight stream; abort if user clicks Stop
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
      onDone: () => {
        setTyping(false);
        endAssistant();
      }
    });
  } catch (err) {
    // Graceful error message
    beginAssistant();
    appendAssistantDelta('\nSorry, my connection hiccuped. Please try again.');
    console.error(err);
  } finally {
    setTyping(false);
    setFormEnabled(true);
    currentAbort = null;
  }
});
