/* chat.js — Keilani Chat + Voice (Local + D-ID)
   v3 — robust audio unlock, Local speech queue, and D-ID audio/video playback
*/

/* ========= DOM HOOKS ========= */
const $ = (sel) => document.querySelector(sel);

const ui = {
  feed:      $('#feed') || $('#msgs') || $('#messages'),
  input:     $('#input'),
  form:      $('#composer') || $('#form'),
  sendBtn:   $('#send'),
  model:     $('#model'),
  api:       $('#api'),
  token:     $('#token'),
  stream:    $('#stream'),           // checkbox
  sse:       $('#sse'),              // checkbox “Expect SSE”
  voice:     $('#voice'),            // select: Off | Local (audio) | D-ID Avatar
  voiceAudio:$('#voiceAudio'),
  voiceVideo:$('#voiceVideo')
};

function need(name) {
  if (!ui[name]) {
    alert(`Missing UI node: ${name}`);
    throw new Error(`Missing UI node: ${name}`);
  }
}
['feed','input','sendBtn','model','api','stream','sse','voice','voiceAudio','voiceVideo'].forEach(need);

console.log('[chat.js] UI found:', ui);

/* ========= PERSISTED CONFIG ========= */
const store = {
  get k() { return 'kln.chat.cfg.v1'; },
  load() {
    try {
      const v = JSON.parse(localStorage.getItem(this.k) || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch { return {}; }
  },
  save(cfg) { localStorage.setItem(this.k, JSON.stringify(cfg||{})); }
};
const cfg = Object.assign({
  api: ui.api?.value || '/api/chat',
  model: ui.model?.value || 'gpt-5',
  stream: !!ui.stream?.checked,
  sse: !!ui.sse?.checked,
  voice: ui.voice?.value || 'off'
}, store.load());

/* reflect */
if (ui.api)   ui.api.value   = cfg.api;
if (ui.model) ui.model.value = cfg.model;
if (ui.stream)ui.stream.checked = !!cfg.stream;
if (ui.sse)   ui.sse.checked    = !!cfg.sse;
if (ui.voice) ui.voice.value    = cfg.voice;

/* ========= SAVE ON CHANGE ========= */
function persist() {
  store.save({
    api: ui.api.value.trim(),
    model: ui.model.value,
    stream: !!ui.stream.checked,
    sse: !!ui.sse.checked,
    voice: ui.voice.value
  });
}
['change','input'].forEach(ev=>{
  [ui.api, ui.model, ui.stream, ui.sse, ui.voice].forEach(n=> n && n.addEventListener(ev, persist));
});

/* ========= UTIL ========= */
function now() {
  const d = new Date();
  return d.toISOString().slice(0,19).replace('T',' ');
}
function addMsg(role, text) {
  if (!ui.feed) return;
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="bubble"><div class="meta">${role} ${now()}</div><div class="body"></div></div>`;
  wrap.querySelector('.body').textContent = text;
  ui.feed.appendChild(wrap);
  ui.feed.scrollTop = ui.feed.scrollHeight;
}
function disabled(btn, on) { if (btn) btn.disabled = !!on; }

/* ========= AUDIO UNLOCK (autoplay policies) ========= */
let unlocked = false;
let audioCtx;
function unlockAudio() {
  if (unlocked) return;
  try {
    // Any user gesture (click/keydown/touch) will call this once
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    // Prime the audio element with a tiny silent buffer
    if (ui.voiceAudio) {
      ui.voiceAudio.muted = false; // we want to hear it
      ui.voiceAudio.playsInline = true;
      const blob = new Blob([new Uint8Array([0])], {type:'audio/mp3'});
      ui.voiceAudio.src = URL.createObjectURL(blob);
      ui.voiceAudio.load();
      ui.voiceAudio.play().catch(()=>{/* ignore primer error */});
    }
    // Prime video element
    if (ui.voiceVideo) {
      ui.voiceVideo.playsInline = true;
      // leave muted = false; D-ID answers sometimes need unmuted to be heard
    }
    unlocked = true;
    console.log('[chat.js] Audio unlocked');
  } catch (e) {
    console.warn('[chat.js] Audio unlock failed', e);
  }
}
// First gesture unlockers
['click','keydown','touchstart'].forEach(ev => window.addEventListener(ev, unlockAudio, { once:true }));

/* ========= LOCAL VOICE (SpeechSynthesis) ========= */
const synth = window.speechSynthesis;
const speakQ = [];
let speaking = false;

function localSpeak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  speakQ.push(String(text));
  drainSpeak();
}
function drainSpeak() {
  if (speaking || speakQ.length === 0) return;
  speaking = true;
  const text = speakQ.shift();

  // Pick a voice if available; otherwise default.
  let voicePick = null;
  try {
    const voices = synth.getVoices();
    // Prefer something “female-ish”/US if present (rough heuristic)
    voicePick = voices.find(v=>/en-US/i.test(v.lang) && /female|samantha|allison|jenny|aria/i.test(v.name))
             || voices.find(v=>/en-US/i.test(v.lang))
             || voices[0];
  } catch {}
  const u = new SpeechSynthesisUtterance(text);
  if (voicePick) u.voice = voicePick;
  u.rate = 1.0; u.pitch = 1.0;

  u.onend = () => { speaking = false; drainSpeak(); };
  u.onerror = () => { speaking = false; drainSpeak(); };

  synth.cancel(); // prevent overlap
  synth.speak(u);
}

/* ========= D-ID VOICE / AVATAR =========
   Expects your Netlify function /api/did-speak to accept:
   { text, mode: 'avatar' | 'audio' }
   and return one of:
   { audio_url }  -> play in <audio>
   { stream_url } -> set <video>.src to this (or WebRTC inside the function)
   { video_url }  -> set <video>.src (for mp4/hls)
*/
async function didSpeak(text, mode) {
  const endpoint = '/api/did-speak';
  const res = await fetch(endpoint, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ text, mode })
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>String(res.status));
    throw new Error(`did-speak ${res.status}: ${t}`);
  }
  const data = await res.json().catch(()=> ({}));
  console.log('[chat.js] did-speak ->', data);

  // Prefer explicit keys; handle both audio & video variants
  if (data.audio_url) {
    // Pure audio (voice only)
    if (!ui.voiceAudio) throw new Error('voice audio element missing');
    ui.voiceAudio.src = data.audio_url;
    await ui.voiceAudio.play().catch(err => console.warn('audio play blocked', err));
  } else if (data.stream_url || data.video_url) {
    if (!ui.voiceVideo) throw new Error('voice video element missing');
    ui.voiceVideo.src = data.stream_url || data.video_url;
    ui.voiceVideo.muted = false;
    await ui.voiceVideo.play().catch(err => console.warn('video play blocked', err));
  } else {
    console.warn('[chat.js] did-speak returned neither audio_url nor video_url');
  }
}

/* ========= SENDER ========= */
async function send(promptText) {
  const api = (ui.api?.value || '/api/chat').trim();
  const model = ui.model?.value || 'gpt-5';
  const expectSSE = !!ui.sse?.checked;
  const wantStream = !!ui.stream?.checked;

  if (!promptText) promptText = ui.input.value.trim();
  if (!promptText) return;

  unlockAudio();                 // make sure audio is allowed
  disabled(ui.sendBtn, true);

  /* add user bubble */
  addMsg('You', promptText);

  /* build payload */
  const payload = {
    model,
    stream: wantStream,
    messages: [{ role:'user', content: promptText }]
  };

  try {
    if (wantStream && expectSSE) {
      // === SSE path ===
      const ctrl = new AbortController();
      const res = await fetch(api, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      if (!res.headers.get('content-type')?.includes('text/event-stream')) {
        // Not SSE — fall back to JSON chunk log
        const txt = await res.text();
        addMsg('Keilani', `⚠ Non-SSE response (content-type: ${res.headers.get('content-type')})\n\n${txt}`);
      } else {
        // stream events
        let acc = '';
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        addMsg('Keilani', '…');    // placeholder
        const last = ui.feed.lastElementChild?.querySelector('.body');

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream:true });
          // minimal SSE line parser
          chunk.split(/\r?\n/).forEach(line=>{
            const m = line.match(/^data:\s*(.*)$/);
            if (m) {
              try {
                const obj = JSON.parse(m[1]);
                const delta = obj?.choices?.[0]?.delta?.content || obj?.delta?.content;
                if (delta) {
                  acc += delta;
                  if (last) last.textContent = acc;
                }
              } catch {}
            }
          });
        }

        // Speak if voice is on
        await maybeSpeak(acc);
      }
    } else {
      // === JSON path ===
      const res = await fetch(api, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const t = await res.text().catch(()=>String(res.status));
        throw new Error(`HTTP ${res.status} ${t}`);
      }
      const data = await res.json();
      const text =
        data?.choices?.[0]?.message?.content ||
        data?.message?.content ||
        data?.content ||
        JSON.stringify(data);
      addMsg('Keilani', text);
      await maybeSpeak(text);
    }
  } catch (err) {
    console.error('[chat.js] send error', err);
    addMsg('Keilani', `⚠ ${err.message || err}`);
  } finally {
    ui.input.value = '';
    disabled(ui.sendBtn, false);
  }
}

/* ========= VOICE DISPATCHER ========= */
async function maybeSpeak(text) {
  const mode = (ui.voice?.value || 'off').toLowerCase();

  if (!text || mode === 'off') return;

  if (mode.startsWith('local')) {
    localSpeak(text);
    return;
  }
  if (mode.includes('d-id')) {
    // You can choose whether you want voice-only or avatar here:
    // - keep it simple: always try avatar, the function can decide
    // - or add two options in the <select> if you want “D-ID Audio” & “D-ID Avatar”
    try {
      await didSpeak(text, 'avatar'); // backend decides (voice cloned, etc.)
    } catch (e) {
      console.warn('didSpeak failed, falling back to Local', e);
      localSpeak(text);
    }
    return;
  }

  // Fallback
  localSpeak(text);
}

/* ========= WIRE UI ========= */
ui.form?.addEventListener('submit', (e)=>{ e.preventDefault(); send(); });
ui.sendBtn?.addEventListener('click', ()=> send());
ui.input?.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

/* ========= EXPOSE FOR MANUAL TEST ========= */
window.__send = send;

/* ========= HELPER: greet once ========= */
(function greetOnce(){
  if (!ui.feed) return;
  if (ui.feed.dataset.greeted) return;
  ui.feed.dataset.greeted = '1';
  addMsg('Keilani',
`Hi! I’m here and working. What can I help you with today? 
• Ask a quick question • Summarize a paragraph • Generate a short code snippet • Translate a sentence`);
})();
