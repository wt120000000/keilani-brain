// public/assets/chat.js
// Streaming chat + ElevenLabs TTS with SINGLE serialized playback loop.

(function () {
  "use strict";

  /* -------------------------------------------------------
   * Helpers
   * ----------------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* -------------------------------------------------------
   * Config
   * ----------------------------------------------------- */
  var PREVIEW_BROWSER_TTS = false; // optional fallback (off by default)
  var MIN_RECORD_MS = 700;
  var STT_MIN_BYTES = 9500;

  /* -------------------------------------------------------
   * State
   * ----------------------------------------------------- */
  var state = {
    lastReply: "",
    queueCursor: 0,
    playbackQueue: [],    // [{ id, text }]
    interrupted: false,
    streamAbort: null,
    mediaRecorder: null,
    chunks: [],
    dailyRoom: null,
    dailyUrl: null,
    meetingToken: null,
    voiceId: null
  };
  var currentAudio = null;
  var audioUnlocked = false;
  var isProcessingQueue = false;   // <—— single runner guard

  /* -------------------------------------------------------
   * Audio unlock (mobile)
   * ----------------------------------------------------- */
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        var ctx = new Ctx();
        ctx.resume && ctx.resume();
        var buf = ctx.createBuffer(1, 1, 22050);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      }
    } catch(e) {}
    audioUnlocked = true;
  }
  document.addEventListener("click", unlockAudio, { once: true });
  document.addEventListener("touchstart", unlockAudio, { once: true });

  /* -------------------------------------------------------
   * Browser TTS (fallback only)
   * ----------------------------------------------------- */
  function speakBrowser(text) {
    if (!PREVIEW_BROWSER_TTS) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
      window.speechSynthesis.speak(u);
    } catch(e) {}
  }
  function cancelBrowserTTS() {
    try { window.speechSynthesis.cancel(); } catch(e) {}
  }

  /* -------------------------------------------------------
   * Hard stop / interrupt
   * ----------------------------------------------------- */
  function cancelPlayback() {
    state.interrupted = true;
    state.playbackQueue.length = 0;
    state.queueCursor = 0;

    try { if (state.streamAbort) state.streamAbort.abort(); } catch(e) {}
    state.streamAbort = null;

    cancelBrowserTTS();

    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = "";
        currentAudio.load && currentAudio.load();
        currentAudio = null;
      }
    } catch(e) {}

    var p = $("ttsPlayer");
    if (p) { try { p.pause(); p.src = ""; p.load && p.load(); } catch(e) {} }
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") cancelPlayback(); });
  var stopBtn = $("stopSpeak");
  if (stopBtn) stopBtn.addEventListener("click", cancelPlayback);

  /* -------------------------------------------------------
   * UI helper
   * ----------------------------------------------------- */
  function setBusy(btn, busy, idleText, busyText) {
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? busyText : idleText;
  }

  /* -------------------------------------------------------
   * ElevenLabs voices dropdown
   * ----------------------------------------------------- */
  (function initVoices() {
    var sel = $("voiceSelect");
    if (!sel) return;

    sel.disabled = true;
    sel.innerHTML = "<option>Loading voices…</option>";
    var saved = localStorage.getItem("voiceId") || "";

    fetch("/api/voices")
      .then(r => r.ok ? r.json() : Promise.reject(new Error("voices http " + r.status)))
      .then(j => {
        var voices = (j && j.voices) ? j.voices : [];
        sel.innerHTML = "";
        voices.slice(0, 5).forEach(v => {
          var opt = document.createElement("option");
          opt.value = v.voice_id;
          opt.textContent = v.name + " (" + v.voice_id.slice(0,6) + "…)";
          sel.appendChild(opt);
        });
        if (!sel.options.length) {
          sel.innerHTML = '<option value="">(no voices)</option>';
          sel.disabled = true;
          state.voiceId = null;
        } else {
          if (saved) {
            for (var i=0;i<sel.options.length;i++) {
              if (sel.options[i].value === saved) sel.selectedIndex = i;
            }
          }
          state.voiceId = sel.value || null;
          sel.disabled = false;
          sel.onchange = function () {
            state.voiceId = sel.value || null;
            localStorage.setItem("voiceId", state.voiceId || "");
          };
        }
      })
      .catch(() => {
        sel.innerHTML = '<option value="">(voices unavailable)</option>';
        sel.disabled = true;
        state.voiceId = null;
      });
  })();

  /* -------------------------------------------------------
   * Sentence chunking
   * ----------------------------------------------------- */
  function extractNewSentences(fullText, cursor) {
    var re = /[^.!?]+[.!?]+(\s+|$)/g;
    re.lastIndex = cursor;
    var out = [], m;
    while ((m = re.exec(fullText))) out.push(m[0].trim());
    return { sentences: out, nextCursor: re.lastIndex };
  }
  function enqueueSentences(text) {
    var res = extractNewSentences(text, state.queueCursor);
    var sentences = res.sentences;
    state.queueCursor = res.nextCursor;

    if (!sentences.length) return;
    for (var i=0;i<sentences.length;i++) {
      state.playbackQueue.push({ id: String(Math.random()), text: sentences[i] });
    }
    processQueue();  // safe — guarded by isProcessingQueue
  }

  /* -------------------------------------------------------
   * TTS helpers (ElevenLabs)
   * ----------------------------------------------------- */
  function ttsUrl(text) {
    var body = { text: text };
    if (state.voiceId) body.voiceId = state.voiceId;

    return fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(r => {
        if (!r.ok) return r.text().then(t => Promise.reject(new Error("tts " + r.status + " " + t.slice(0,120))));
        var ct = r.headers.get("content-type") || "";
        if (ct.indexOf("audio") === -1) return Promise.reject(new Error("tts bad content-type " + ct));
        return r.blob();
      })
      .then(blob => URL.createObjectURL(blob))
      .catch(() => "");
  }

  function playAudioUrl(url) {
    return new Promise(resolve => {
      cancelBrowserTTS();

      var visible = $("ttsPlayer");
      var a = new Audio();
      currentAudio = a;
      a.src = url;
      a.preload = "auto";

      function cleanup() {
        try { URL.revokeObjectURL(url); } catch(e) {}
        resolve();
      }
      a.onended = cleanup;
      a.onerror = cleanup;

      if (visible) visible.src = url;

      a.play().catch(() => {
        try { visible && visible.play && visible.play(); } catch(e) {}
      });
    });
  }

  /* -------------------------------------------------------
   * SINGLE Queue runner
   * ----------------------------------------------------- */
  async function processQueue() {
    if (isProcessingQueue) return;           // <—— guard
    isProcessingQueue = true;

    try {
      while (!state.interrupted && state.playbackQueue.length) {
        var item = state.playbackQueue.shift();
        if (!item) break;

        var url = "";
        try { url = await ttsUrl(item.text); } catch(e) { url = ""; }

        if (state.interrupted) break;

        if (url) {
          cancelBrowserTTS();
          await playAudioUrl(url);           // serialize by awaiting
        } else {
          // fallback to browser TTS (optional)
          speakBrowser(item.text);
          await sleep(Math.min(1500, item.text.length * 40));
        }

        // small pacing delay to avoid hammering TTS API in bursts
        await sleep(80);
      }
    } finally {
      isProcessingQueue = false;
    }
  }

  /* -------------------------------------------------------
   * SSE streaming
   * ----------------------------------------------------- */
  function chatStream(message, onDelta) {
    var ac = new AbortController();
    state.streamAbort = ac;

    return fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message }),
      signal: ac.signal
    }).then(res => {
      if (!res.ok) return res.text().then(t => Promise.reject(new Error("chat-stream " + res.status + " " + t.slice(0,120))));
      if (!res.body) throw new Error("no stream body");
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "";

      function pump() {
        return reader.read().then(({value, done}) => {
          if (done) return;
          buf += dec.decode(value, { stream: true });

          var frames = buf.split("\n\n");
          buf = frames.pop() || "";

          for (var i=0;i<frames.length;i++) {
            var line = frames[i].trim();
            if (line.indexOf("data:") !== 0) continue;
            var raw = line.slice(5).trim();
            if (!raw) continue;

            var json;
            try { json = JSON.parse(raw); } catch(e) { continue; }

            var text =
              (json && json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) ||
              json.delta || json.text || "";

            if (typeof text === "string" && text.length) onDelta(text);
          }
          return pump();
        });
      }

      return pump();
    });
  }

  async function chatStreamToTTS(userText) {
    var full = "";
    try {
      await chatStream(userText, function (delta) {
        if (state.interrupted) return;
        full += delta;
        var r = $("reply"); if (r) r.textContent = full;
        state.lastReply = full;
        enqueueSentences(full);
      });
    } finally {
      // flush last tail (no punctuation)
      var tail = (full.slice(state.queueCursor) || "").trim();
      if (tail) {
        state.playbackQueue.push({ id: String(Math.random()), text: tail });
        processQueue();
        state.queueCursor = full.length;
      }
      state.streamAbort = null;
    }
  }

  /* -------------------------------------------------------
   * Send text
   * ----------------------------------------------------- */
  var sendBtn = $("sendText");
  if (sendBtn) {
    sendBtn.addEventListener("click", function () {
      var input = $("textIn");
      var text = input && input.value ? String(input.value).trim() : "";
      if (!text) return;

      cancelPlayback();
      cancelBrowserTTS();
      state.interrupted = false;
      state.queueCursor = 0;
      var r = $("reply"); if (r) r.textContent = "";
      if (input) input.value = "";

      chatStreamToTTS(text).catch(e => {
        var rr = $("reply");
        if (rr) rr.textContent = "⚠️ " + (e.message || "stream failed");
      });
    });
  }

  /* -------------------------------------------------------
   * Speak reply (re-synthesize full)
   * ----------------------------------------------------- */
  var speakBtn = $("speakReply");
  if (speakBtn) {
    speakBtn.addEventListener("click", function () {
      var text = (state.lastReply || "").trim();
      if (!text) return;

      cancelPlayback();
      cancelBrowserTTS();
      state.interrupted = false;

      setBusy(speakBtn, true, "Speak Reply", "Speaking…");
      ttsUrl(text)
        .then(url => { if (url) return playAudioUrl(url); else speakBrowser(text); })
        .finally(() => setBusy(speakBtn, false, "Speak Reply", "Speaking…"));
    });
  }

  /* -------------------------------------------------------
   * Push-to-talk
   * ----------------------------------------------------- */
  function pickAudioMime() {
    var list = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    for (var i=0;i<list.length;i++) {
      if (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(list[i])) {
        return list[i];
      }
    }
    return "";
  }

  var pttBtn = $("pttBtn");
  if (pttBtn) {
    pttBtn.onmousedown = startRecording;
    pttBtn.onmouseup   = stopRecording;
    pttBtn.ontouchstart = function (e) { e.preventDefault(); startRecording(); };
    pttBtn.ontouchend   = function (e) { e.preventDefault(); stopRecording(); };
  }

  function startRecording() {
    var s = $("recState"); if (s) s.textContent = "recording…";

    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true }
    }).then(function (stream) {
      state.chunks = [];
      var mimeType = pickAudioMime();
      try { state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : {}); }
      catch(e) { state.mediaRecorder = new MediaRecorder(stream); }
      var startedAt = Date.now();

      state.mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size) state.chunks.push(e.data); };

      state.mediaRecorder.onstop = function () {
        var s2 = $("recState"); if (s2) s2.textContent = "processing…";
        try {
          var blob = new Blob(state.chunks, { type: mimeType || "audio/webm" });
          var ms = Date.now() - startedAt;
          if (ms < MIN_RECORD_MS || blob.size < STT_MIN_BYTES) {
            var t = $("transcript"); if (t) t.textContent = "Hold to talk for ~1–2 seconds 👍";
            var s3 = $("recState"); if (s3) s3.textContent = "idle";
            try { stream.getTracks().forEach(tr => tr.stop()); } catch(e) {}
            return;
          }

          var fr = new FileReader();
          fr.onloadend = function () {
            var b64 = fr.result || "";
            fetch("/api/stt", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ audioBase64: b64 })
            })
              .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(new Error(t))))
              .then(stt => {
                var trEl = $("transcript"); if (trEl) trEl.textContent = stt.text || "";
                if ((stt.text || "").trim()) {
                  cancelPlayback();
                  cancelBrowserTTS();
                  state.interrupted = false;
                  state.queueCursor = 0;
                  var rr = $("reply"); if (rr) rr.textContent = "";
                  return chatStreamToTTS(stt.text);
                }
              })
              .catch(e => {
                var trEl = $("transcript"); if (trEl) trEl.textContent = "Couldn’t transcribe. Try again.";
                console.error("STT error:", e);
              })
              .finally(() => {
                var s4 = $("recState"); if (s4) s4.textContent = "idle";
                try { stream.getTracks().forEach(tr => tr.stop()); } catch(e) {}
              });
          };
          fr.readAsDataURL(blob);
        } catch(err) {
          var s5 = $("recState"); if (s5) s5.textContent = "idle";
          console.error("PTT stop error:", err);
          try { stream.getTracks().forEach(tr => tr.stop()); } catch(e) {}
        }
      };

      state.mediaRecorder.start();
    }).catch(e => {
      var s6 = $("recState"); if (s6) s6.textContent = "idle";
      console.error("getUserMedia error:", e);
    });
  }
  function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      try { state.mediaRecorder.stop(); } catch(e) {}
    }
  }

  /* -------------------------------------------------------
   * Daily (RTC) – simple hooks
   * ----------------------------------------------------- */
  var createRoomBtn = $("createRoom");
  if (createRoomBtn) {
    createRoomBtn.addEventListener("click", function () {
      fetch("/api/rtc/create-room", { method: "POST" })
        .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(new Error(t))))
        .then(j => {
          state.dailyRoom = j.room;
          state.dailyUrl = j.url;
          var info = $("roomInfo"); if (info) info.textContent = "Room: " + j.room;
        })
        .catch(e => console.error("create room error", e));
    });
  }

  var iframe = null;
  var openRoomBtn = $("openRoom");
  if (openRoomBtn) {
    openRoomBtn.addEventListener("click", function () {
      function actuallyOpen() {
        fetch("/api/rtc/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: state.dailyRoom, userName: "Guest" })
        })
          .then(r => r.ok ? r.json() : {})
          .then(tok => {
            state.meetingToken = tok && tok.token ? tok.token : null;
            var mount = $("dailyMount");
            if (!mount) return;
            mount.innerHTML = "";

            iframe = document.createElement("iframe");
            var url = new URL(state.dailyUrl);
            if (state.meetingToken) url.searchParams.set("t", state.meetingToken);
            iframe.src = url.toString();
            iframe.allow = "camera; microphone; display-capture";
            iframe.style.width = "100%";
            iframe.style.height = "540px";
            iframe.style.border = "0";
            iframe.style.borderRadius = "12px";
            mount.appendChild(iframe);
          })
          .catch(e => console.error("token/open error", e));
      }

      if (!state.dailyRoom) {
        fetch("/api/rtc/create-room", { method: "POST" })
          .then(r => r.ok ? r.json() : Promise.reject(new Error("create failed")))
          .then(j => {
            state.dailyRoom = j.room;
            state.dailyUrl = j.url;
            var info = $("roomInfo"); if (info) info.textContent = "Room: " + j.room;
            actuallyOpen();
          })
          .catch(e => console.error(e));
      } else {
        actuallyOpen();
      }
    });
  }

  var closeRoomBtn = $("closeRoom");
  if (closeRoomBtn) {
    closeRoomBtn.addEventListener("click", function () {
      var mount = $("dailyMount");
      if (mount) mount.innerHTML = "";
      iframe = null;
    });
  }

  /* -------------------------------------------------------
   * Avatar hook (optional)
   * ----------------------------------------------------- */
  function feedAvatar(text) {
    var el = $("avatarFeed");
    if (el) el.textContent = (text || "").slice(0, 1200);
  }

})();
