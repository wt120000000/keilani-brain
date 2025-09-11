/* public/js/chat.js
   Chat + SSE + optional voice (Browser TTS or D-ID Avatar)
   - No external deps
   - Works with /api/chat (JSON & SSE) and /.netlify/functions/did-speak
*/
(() => {
  "use strict";

  // ----------------------- Helpers (must be first) -----------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const nowIso = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  // Hoisted-safe randId (no usage before declaration)
  const randId = (() => {
    let c = 0;
    return (p = "id") => `${p}-${Date.now().toString(36)}-${(c++).toString(36)}`;
  })();

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
      catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    }
  };

  const ui = {
    feed:   $("#feed"),
    input:  $("#composer-input"),
    form:   $("#composer-form"),
    sendBtn: $("#send-btn"),

    // controls
    api:    $("#api"),
    model:  $("#model"),
    token:  $("#token"),
    stream: $("#stream"),
    sse:    $("#expect-sse"),
    voice:  $("#voice-mode"),

    // counters & bits
    tokens: $("#tokens"),
    sid:    $("#sid"),

    // voice dock
    voiceDock: $("#voice-dock"),
    voiceVideo: $("#voice-video"),
    voiceAudio: $("#voice-audio"),
  };

  // Sanity check
  {
    const missing = Object.entries(ui).filter(([k, v]) => !v).map(([k]) => k);
    if (missing.length) {
      console.error("[chat.js] Missing UI nodes:", missing.join(", "));
      return; // hard stop; DOM doesn't match
    }
  }

  // ----------------------- Persistent state -----------------------
  const state = {
    sid: store.get("sid", randId("sid")),
    messages: [],                 // running transcript
    api: store.get("api", ui.api.value || "/api/chat"),
    model: store.get("model", ui.model.value || "gpt-5"),
    token: store.get("token", ""),
    stream: store.get("stream", true),
    expectSSE: store.get("expectSSE", true),
    voice: store.get("voice", "off"), // off | audio | avatar
  };

  // Reflect persistent to UI
  ui.api.value = state.api;
  ui.model.value = state.model;
  ui.token.value = state.token;
  ui.stream.checked = !!state.stream;
  ui.sse.checked = !!state.expectSSE;
  ui.voice.value = state.voice;
  ui.sid.textContent = state.sid;

  console.log("[chat.js] UI found:", {
    feed: !!ui.feed, input: !!ui.input, form: !!ui.form, sendBtn: !!ui.sendBtn,
    model: !!ui.model, api: !!ui.api, token: !!ui.token,
    stream: !!ui.stream, sse: !!ui.sse, voice: !!ui.voice,
  });

  // ----------------------- Message render -----------------------
  function bubble(role, text) {
    const div = document.createElement("div");
    div.className = "msg";
    div.dataset.role = role;
    div.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-meta">${role === "assistant" ? "Keilani" : "You"} <span class="muted">${nowIso()}</span></div>
        <div class="msg-content"></div>
      </div>
    `;
    $(".msg-content", div).textContent = text;
    return div;
  }
  function pushUser(text) {
    state.messages.push({ role: "user", content: text });
    ui.feed.appendChild(bubble("user", text));
    ui.feed.scrollTop = ui.feed.scrollHeight;
  }
  function pushAssistant(text) {
    state.messages.push({ role: "assistant", content: text });
    ui.feed.appendChild(bubble("assistant", text));
    ui.feed.scrollTop = ui.feed.scrollHeight;
  }

  // ----------------------- Voice helpers -----------------------
  const voice = {
    // browser TTS (no network)
    speakLocal(text) {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch (e) { console.warn("speechSynthesis not available", e); }
    },

    // D-ID async talk create + poll
    async speakAvatar(text) {
      // POST create talk
      const res = await fetch("/api/did-speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const err = await res.text().catch(()=>"");
        throw new Error(`did-speak POST ${res.status}: ${err}`);
      }
      const { id } = await res.json();

      // poll status
      const url = `/api/did-speak?id=${encodeURIComponent(id)}`;
      let tries = 0;
      while (tries++ < 100) {
        await new Promise(r=>setTimeout(r, 1200));
        const r = await fetch(url);
        if (!r.ok) continue;
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        if (j.status === "done" && j.url) return j.url;
      }
      throw new Error("D-ID talk not ready (timeout)");
    },

    // show media in dock (video preferred, else audio)
    playUrl(maybeUrl) {
      if (!maybeUrl) return;
      // Prefer video (D-ID returns video/mp4)
      if (ui.voiceVideo) {
        ui.voiceVideo.src = maybeUrl;
        ui.voiceVideo.muted = false;
        ui.voiceVideo.playsInline = true;
        ui.voiceVideo.autoplay = true;
        ui.voiceVideo.style.display = "";
        ui.voiceAudio.style.display = "none";
        ui.voiceVideo.play().catch(()=>{});
        return;
      }
      // fallback audio
      ui.voiceAudio.src = maybeUrl;
      ui.voiceAudio.style.display = "";
      ui.voiceAudio.play().catch(()=>{});
    }
  };

  // ----------------------- Chat core -----------------------
  async function send() {
    const text = ui.input.value.trim();
    if (!text) return;
    ui.input.value = "";

    pushUser(text);
    const payload = {
      model: ui.model.value || state.model,
      stream: !!ui.stream.checked,
      messages: buildMessages(),
      sid: state.sid
    };

    // JSON (no SSE)
    if (!ui.sse.checked) {
      try {
        const res = await fetch(ui.api.value || state.api, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(ui.token.value ? { "X-Client-Token": ui.token.value } : {})
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const text = (data && data.content) || data.output || data.text || "";
        if (text) {
          pushAssistant(text);
          handleVoice(text);
        } else {
          pushAssistant("[Empty response]");
        }
      } catch (e) {
        pushAssistant(`⚠ ${e.message}`);
      }
      return;
    }

    // SSE
    try {
      const res = await fetch(ui.api.value || state.api, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(ui.token.value ? { "X-Client-Token": ui.token.value } : {})
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let assistantBuf = "";
      let assistantPushed = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });

        const lines = acc.split(/\r?\n/);
        acc = lines.pop() || ""; // keep last partial

        for (const ln of lines) {
          if (!ln) continue;
          if (ln.startsWith("data:")) {
            const raw = ln.slice(5).trim();
            if (raw === "[DONE]") continue;
            try {
              const evt = JSON.parse(raw);
              // openai-compatible chunk: evt.choices[0].delta.content
              const part = (((evt.choices||[])[0]||{}).delta||{}).content || "";
              if (part) {
                if (!assistantPushed) {
                  pushAssistant(""); // create bubble first time
                  assistantPushed = true;
                }
                assistantBuf += part;
                // update last assistant bubble
                const last = ui.feed.lastElementChild;
                if (last && last.dataset.role === "assistant") {
                  $(".msg-content", last).textContent = assistantBuf;
                }
                ui.feed.scrollTop = ui.feed.scrollHeight;
              }
            } catch {
              // not JSON? ignore chunks
            }
          }
        }
      }

      if (!assistantPushed) {
        pushAssistant("[No tokens]");
      } else {
        handleVoice(assistantBuf);
      }
    } catch (e) {
      pushAssistant(`⚠ ${e.message}`);
    }
  }

  function buildMessages() {
    // Keep a short running transcript from DOM (simple & stateless)
    const msgs = [];
    $$(".msg", ui.feed).forEach(div => {
      const role = div.dataset.role || "assistant";
      const content = $(".msg-content", div)?.textContent || "";
      msgs.push({ role, content });
    });
    // also include the just-sent user message at the end if present
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "user" && (!msgs.length || msgs[msgs.length - 1].content !== last.content)) {
      msgs.push(last);
    }
    return msgs.slice(-30); // keep it reasonable
  }

  // ----------------------- Voice routing -----------------------
  async function handleVoice(text) {
    const mode = ui.voice.value || "off";
    if (!text || mode === "off") return;

    if (mode === "audio") {
      voice.speakLocal(text);
      return;
    }
    if (mode === "avatar") {
      try {
        const url = await voice.speakAvatar(text);
        // show dock and play
        if (ui.voiceDock) ui.voiceDock.style.display = "";
        voice.playUrl(url);
      } catch (e) {
        console.warn("D-ID voice error:", e);
      }
    }
  }

  // ----------------------- Wire events -----------------------
  on(ui.form, "submit", (e) => { e.preventDefault(); send(); });
  on(ui.sendBtn, "click", (e) => { e.preventDefault(); send(); });

  on(ui.api, "change", () => { state.api = ui.api.value; store.set("api", state.api); });
  on(ui.model, "change", () => { state.model = ui.model.value; store.set("model", state.model); });
  on(ui.token, "change", () => { state.token = ui.token.value; store.set("token", state.token); });
  on(ui.stream, "change", () => { state.stream = !!ui.stream.checked; store.set("stream", state.stream); });
  on(ui.sse, "change", () => { state.expectSSE = !!ui.sse.checked; store.set("expectSSE", state.expectSSE); });
  on(ui.voice, "change", () => { state.voice = ui.voice.value; store.set("voice", state.voice); });

  // expose for quick testing
  window.__send = send;
  console.log("[chat.js] Ready. Tip: call window.__send() in console to force a send.");
})();
