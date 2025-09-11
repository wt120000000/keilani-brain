// public/js/chat.js  (voice-enabled)

(() => {
  const $ = (s, p=document) => p.querySelector(s);

  const ui = {
    model:     $("#model"),
    api:       $("#api"),
    token:     $("#token"),
    stream:    $("#stream"),
    sse:       $("#sse"),
    voiceMode: $("#voiceMode"),
    feed:      $("#feed"),
    input:     $("#input"),
    form:      $("#form"),
    sendBtn:   $("#sendBtn"),
    saveBtn:   $("#saveBtn"),
    exportBtn: $("#exportBtn"),
    clearBtn:  $("#clearBtn"),
    resetBtn:  $("#resetBtn"),
    tokens:    $("#tokens"),
    sid:       $("#sid"),
    rawBtn:    $("#rawBtn"),
    dock:      $("#avatarDock"),
    video:     $("#avatarVideo"),
  };

  // --- simple state ---
  let sessionId = randId();
  let msgs = [];

  // restore persisted config
  try {
    const cfg = JSON.parse(localStorage.getItem("chat.cfg") || "{}");
    if (cfg.model) ui.model.value = cfg.model;
    if (cfg.api)   ui.api.value   = cfg.api;
    if (cfg.stream !== undefined) ui.stream.checked = cfg.stream;
    if (cfg.sse !== undefined)    ui.sse.checked    = cfg.sse;
    if (cfg.voiceMode)            ui.voiceMode.value = cfg.voiceMode;
  } catch {}

  ui.sid.textContent = "SID: " + sessionId;

  // Welcome bubble
  addSys("Hi! I’m here and working. What can I help you with today?\n• Ask a quick question\n• Summarize a paragraph\n• Generate a short code snippet\n• Translate a sentence");

  // Events
  ui.saveBtn.onclick   = saveCfg;
  ui.clearBtn.onclick  = () => { msgs = []; ui.feed.innerHTML = ""; };
  ui.resetBtn.onclick  = () => { sessionId = randId(); ui.sid.textContent = "SID: " + sessionId; };
  ui.exportBtn.onclick = exportTxt;
  ui.form.addEventListener("submit", onSend);
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ui.form.requestSubmit();
    }
  });

  // ---- core send ----
  async function onSend(e) {
    e.preventDefault();
    const text = ui.input.value.trim();
    if (!text) return;
    ui.input.value = "";

    addUser(text);

    // push to history
    msgs.push({ role:"user", content: text });

    try {
      const body = {
        model: ui.model.value,
        messages: msgs.map(m => ({ role:m.role, content:m.content })),
        stream: !!ui.stream.checked
      };

      const expectSSE = !!ui.sse.checked;
      const endpoint  = (ui.api.value || "").trim() || "/api/chat";

      addAssistant("…", true); // placeholder bubble with typing state
      const bubble = ui.feed.lastElementChild;

      if (expectSSE) {
        await streamSSE(endpoint, body, bubble);
      } else {
        await postJSON(endpoint, body, bubble);
      }
    } catch (err) {
      addAssistant("⚠ " + (err?.message || String(err)), false, true);
    }
  }

  // --- Network helpers ---
  async function streamSSE(url, payload, bubble) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const ctype = r.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      // non-SSE fallback (some proxies)
      return postJSON(url, payload, bubble);
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder("utf-8");
    let acc = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream:true });

      // parse SSE lines
      let idx;
      while ((idx = acc.indexOf("\n\n")) >= 0) {
        const chunk = acc.slice(0, idx).trim();
        acc = acc.slice(idx + 2);
        if (!chunk) continue;

        // event-stream lines look like: "data: {...}"
        const line = chunk.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;

        const json = line.slice(5).trim();
        if (json === "[DONE]") break;

        try {
          const o = JSON.parse(json);
          // openai-ish: o.choices[0].delta.content
          const delta = o?.choices?.[0]?.delta?.content || "";
          if (delta) {
            full += delta;
            bubble.querySelector(".body").textContent = full;
          }
        } catch {
          // if some upstream returns plain text, append raw
          full += json;
          bubble.querySelector(".body").textContent = full;
        }
      }
    }

    finalizeAssistant(bubble, full);
  }

  async function postJSON(url, payload, bubble) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const ctype = r.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      const data = await r.json();
      const text =
        data?.choices?.[0]?.message?.content ||
        data?.content ||
        JSON.stringify(data);
      finalizeAssistant(bubble, text);
      return;
    }

    // Some proxies send text/plain or text/event-stream but actually one-shot text
    const t = await r.text();
    finalizeAssistant(bubble, t);
  }

  // --- Rendering ---
  function addUser(text) {
    const el = document.createElement("div");
    el.className = "msg you";
    el.innerHTML = `
      <div class="meta">You • ${time()}</div>
      <div class="body"></div>`;
    $(".body", el).textContent = text;
    ui.feed.appendChild(el);
    el.scrollIntoView({ block:"end" });
  }

  function addAssistant(text, typing=false, bad=false) {
    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `
      <div class="meta">Keilani • ${time()}</div>
      <div class="body${bad ? " bad": ""}">${typing ? "…" : ""}</div>`;
    if (!typing) $(".body", el).textContent = text;
    ui.feed.appendChild(el);
    el.scrollIntoView({ block:"end" });
    return el;
  }

  function addSys(text) {
    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `<div class="meta">Keilani</div><div class="body"></div>`;
    $(".body", el).textContent = text;
    ui.feed.appendChild(el);
  }

  function finalizeAssistant(bubble, text) {
    $(".body", bubble).textContent = text || "";
    msgs.push({ role:"assistant", content: text || "" });

    // VOICE: speak based on mode
    const mode = ui.voiceMode.value;
    if (mode === "audio") speakBrowser(text || "");
    if (mode === "avatar") speakAvatar(text || "");

    bubble.scrollIntoView({ block:"end" });
  }

  // --- Voice: Browser Speech Synthesis (fallback, no keys) ---
  function speakBrowser(text) {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  // --- Voice: D-ID avatar video via Netlify function ---
  async function speakAvatar(text) {
    if (!text.trim()) return;
    try {
      // 1) create talk
      const r = await fetch("/api/did-speak", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ text })
      });
      const { id, error } = await r.json();
      if (!id) throw new Error(error || "Failed to create talk");

      // 2) poll for completion
      const url = await pollTalk(id, 60_000); // up to 60s
      if (!url) throw new Error("Timeout waiting for D-ID");

      // 3) show video
      ui.video.src = url;
      ui.dock.style.display = "block";
      ui.video.muted = false;    // let it speak
      ui.video.play().catch(()=>{});
    } catch (err) {
      addAssistant("⚠ Voice error: " + (err?.message || String(err)), false, true);
    }
  }

  async function pollTalk(id, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await delay(1200);
      const r = await fetch(`/api/did-speak?id=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.status === "done" && j.url) return j.url;
      if (j.status === "error") throw new Error(j.error || "D-ID error");
    }
    return null;
  }

  // --- utils ---
  function saveCfg() {
    const cfg = {
      model: ui.model.value,
      api: ui.api.value,
      stream: ui.stream.checked,
      sse: ui.sse.checked,
      voiceMode: ui.voiceMode.value,
    };
    localStorage.setItem("chat.cfg", JSON.stringify(cfg));
  }
  function exportTxt() {
    const txt = msgs.map(m => `${m.role.toUpperCase()}:\n${m.content}\n`).join("\n");
    const b = new Blob([txt], { type:"text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `keilani-${new Date().toISOString().slice(0,19)}.txt`;
    a.click();
  }
  const randId = () => Math.random().toString(36).slice(2, 10);
  const time   = () => dayjs().format("YYYY-MM-DD HH:mm:ss");
  const delay  = (ms) => new Promise(r => setTimeout(r, ms));

  // Log UI map once for sanity
  console.log("[chat.js] UI ready:", Object.fromEntries(Object.entries(ui).map(([k,v]) => [k,!!v])));
})();
