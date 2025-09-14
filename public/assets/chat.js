// public/assets/chat.js
// Single-voice streaming chat with ElevenLabs TTS (fallback to browser TTS optional)

(function () {
  "use strict";

  /* ==========================================================================
     DOM UTIL
  ========================================================================== */
  function $(id) { return document.getElementById(id); }

  /* ==========================================================================
     CONFIG
  ========================================================================== */
  // Turn this on ONLY if you want local (browser) TTS as a fallback.
  var PREVIEW_BROWSER_TTS = false;

  var MIN_RECORD_MS = 700;   // min ptt hold
  var STT_MIN_BYTES = 9500;  // ignore tiny blobs

  /* ==========================================================================
     STATE
  ========================================================================== */
  var state = {
    lastReply: "",
    queueCursor: 0,
    playbackQueue: [],      // [{id, text, status}]
    interrupted: false,
    streamAbort: null,      // AbortController for SSE
    mediaRecorder: null,
    chunks: [],
    dailyRoom: null,
    dailyUrl: null,
    meetingToken: null,
    voiceId: null
  };

  var currentAudio = null;
  var audioUnlocked = false;

  /* ==========================================================================
     AUDIO UNLOCK
  ========================================================================== */
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
    } catch (e) {}
    audioUnlocked = true;
  }
  document.addEventListener("click", unlockAudio, { once: true });
  document.addEventListener("touchstart", unlockAudio, { once: true });

  /* ==========================================================================
     BROWSER TTS (optional) + CANCEL
  ========================================================================== */
  function speakBrowser(text) {
    if (!PREVIEW_BROWSER_TTS) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.pitch = 1.0;
      u.volume = 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  function cancelBrowserTTS() {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }

  /* ==========================================================================
     HARD STOP / INTERRUPT
  ========================================================================== */
  function cancelPlayback() {
    state.playbackQueue = [];
    state.queueCursor = 0;
    state.interrupted = true;

    try { if (state.streamAbort) state.streamAbort.abort(); } catch (e) {}
    state.streamAbort = null;

    cancelBrowserTTS();

    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = "";
        currentAudio.load && currentAudio.load();
        currentAudio = null;
      }
    } catch (e) {}

    var p = $("ttsPlayer");
    if (p) {
      try { p.pause(); p.src = ""; p.load && p.load(); } catch (e) {}
    }
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") cancelPlayback();
  });
  var stopBtn = $("stopSpeak");
  if (stopBtn) stopBtn.addEventListener("click", cancelPlayback);

  /* ==========================================================================
     UI HELPERS
  ========================================================================== */
  function setBusy(btn, busy, idleText, busyText) {
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? busyText : idleText;
  }

  /* ==========================================================================
     ELEVENLABS VOICES
  ========================================================================== */
  (function initVoices() {
    var sel = $("voiceSelect");
    if (!sel) return;

    sel.disabled = true;
    sel.innerHTML = "<option>Loading voices…</option>";
    var saved = localStorage.getItem("voiceId") || "";

    fetch("/api/voices")
      .then(function (r) {
        if (!r.ok) throw new Error("voices http " + r.status);
        return r.json();
      })
      .then(function (j) {
        var voices = j && j.voices ? j.voices : [];
        sel.innerHTML = "";
        voices.slice(0, 5).forEach(function (v) {
          var opt = document.createElement("option");
          opt.value = v.voice_id;
          opt.textContent = v.name + " (" + v.voice_id.slice(0, 6) + "…)";
          sel.appendChild(opt);
        });

        if (!sel.options.length) {
          sel.innerHTML = '<option value="">(no voices)</option>';
          sel.disabled = true;
          state.voiceId = null;
        } else {
          if (saved) {
            for (var i = 0; i < sel.options.length; i++) {
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
      .catch(function () {
        sel.innerHTML = '<option value="">(voices unavailable)</option>';
        sel.disabled = true;
        state.voiceId = null;
      });
  })();

  /* ==========================================================================
     SENTENCE CHUNKING
  ========================================================================== */
  function extractNewSentences(fullText, cursor) {
    var re = /[^.!?]+[.!?]+(\s+|$)/g;
    re.lastIndex = cursor;
    var out = [];
    var m;
    while ((m = re.exec(fullText))) out.push(m[0].trim());
    return { sentences: out, nextCursor: re.lastIndex };
  }

  function enqueueSentences(text) {
    var res = extractNewSentences(text, state.queueCursor);
    var sentences = res.sentences;
    state.queueCursor = res.nextCursor;

    if (sentences.length) {
      for (var i = 0; i < sentences.length; i++) {
        state.playbackQueue.push({ id: String(Math.random()), text: sentences[i], status: "queued" });
      }
      processQueue();
    }
  }

  /* ==========================================================================
     TTS HELPERS (ElevenLabs)
  ========================================================================== */
  function ttsUrl(text) {
    var body = { text: text };
    if (state.voiceId) body.voiceId = state.voiceId;

    return fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (!r.ok) return Promise.reject(new Error("tts http " + r.status));
        var ct = r.headers.get("content-type") || "";
        if (ct.indexOf("audio") === -1) return Promise.reject(new Error("tts bad content-type " + ct));
        return r.blob();
      })
      .then(function (blob) {
        return URL.createObjectURL(blob);
      })
      .catch(function () {
        return "";
      });
  }

  function playAudioUrl(url) {
    return new Promise(function (resolve) {
      cancelBrowserTTS();

      var visible = $("ttsPlayer");
      var a = new Audio();
      currentAudio = a;
      a.src = url;
      a.preload = "auto";

      function cleanup() {
        try { URL.revokeObjectURL(url); } catch (e) {}
        resolve();
      }
      a.onended = cleanup;
      a.onerror = cleanup;

      if (visible) visible.src = url;

      a.play().catch(function () {
        try { if (visible && visible.play) visible.play(); } catch (e) {}
      });
    });
  }

  function processQueue() {
    if (state.interrupted) return;

    (function next() {
      if (state.interrupted) return;
      if (!state.playbackQueue.length) return;

      var item = state.playbackQueue.shift();
      if (!item) return;

      // ElevenLabs first
      ttsUrl(item.text)
        .then(function (url) {
          if (state.interrupted) return;
          if (url) {
            cancelBrowserTTS();
            return playAudioUrl(url);
          } else {
            // optional fallback
            speakBrowser(item.text);
          }
        })
        .then(function () {
          if (!state.interrupted) next();
        })
        .catch(function () {
          if (!state.interrupted) next();
        });
    })();
  }

  /* ==========================================================================
     STREAMING CHAT (SSE)
  ========================================================================== */
  function chatStream(message, onDelta) {
    var ac = new AbortController();
    state.streamAbort = ac;

    return fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message }),
      signal: ac.signal
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("chat-stream " + res.status + " " + t); });
      if (!res.body) throw new Error("no stream body");

      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "";

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buf += dec.decode(chunk.value, { stream: true });

          var frames = buf.split("\n\n");
          buf = frames.pop() || "";

          for (var i = 0; i < frames.length; i++) {
            var line = frames[i].trim();
            if (line.indexOf("data:") !== 0) continue;
            var raw = line.slice(5).trim();
            if (!raw) continue;

            var json;
            try { json = JSON.parse(raw); } catch (e) { continue; }

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

  function chatStreamToTTS(userText) {
    var full = "";

    return chatStream(userText, function (delta) {
      if (state.interrupted) return;
      full += delta;
      var r = $("reply");
      if (r) r.textContent = full;
      state.lastReply = full;
      enqueueSentences(full);
    }).finally(function () {
      // flush tail
      var tail = (full.slice(state.queueCursor) || "").trim();
      if (tail) {
        state.playbackQueue.push({ id: String(Math.random()), text: tail, status: "queued" });
        processQueue();
        state.queueCursor = full.length;
      }
      state.streamAbort = null;
    });
  }

  /* ==========================================================================
     SEND (text)
  ========================================================================== */
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
      var r = $("reply");
      if (r) r.textContent = "";
      if (input) input.value = "";

      chatStreamToTTS(text)
        .catch(function (e) {
          var rr = $("reply");
          if (rr) rr.textContent = "⚠️ " + (e.message || "stream failed");
        });
    });
  }

  /* ==========================================================================
     SPEAK REPLY
  ========================================================================== */
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
        .then(function (url) {
          if (url) {
            cancelBrowserTTS();
            return playAudioUrl(url);
          } else {
            speakBrowser(text);
          }
        })
        .finally(function () {
          setBusy(speakBtn, false, "Speak Reply", "Speaking…");
        });
    });
  }

  /* ==========================================================================
     PUSH-TO-TALK
  ========================================================================== */
  function pickAudioMime() {
    var list = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    for (var i = 0; i < list.length; i++) {
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
      try {
        state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : {});
      } catch (e) {
        state.mediaRecorder = new MediaRecorder(stream);
      }
      var startedAt = Date.now();

      state.mediaRecorder.ondataavailable = function (e) {
        if (e.data && e.data.size) state.chunks.push(e.data);
      };

      state.mediaRecorder.onstop = function () {
        var s2 = $("recState"); if (s2) s2.textContent = "processing…";
        try {
          var blob = new Blob(state.chunks, { type: mimeType || "audio/webm" });
          var ms = Date.now() - startedAt;
          if (ms < MIN_RECORD_MS || blob.size < STT_MIN_BYTES) {
            var t = $("transcript");
            if (t) t.textContent = "Hold to talk for ~1–2 seconds 👍";
            var s3 = $("recState"); if (s3) s3.textContent = "idle";
            try { stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
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
              .then(function (r) {
                if (!r.ok) return r.text().then(function (txt) { throw new Error(txt); });
                return r.json();
              })
              .then(function (stt) {
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
              .catch(function (e) {
                var trEl = $("transcript"); if (trEl) trEl.textContent = "Couldn’t transcribe. Try again.";
                console.error("STT error:", e);
              })
              .finally(function () {
                var s4 = $("recState"); if (s4) s4.textContent = "idle";
                try { stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
              });
          };
          fr.readAsDataURL(blob);
        } catch (err) {
          var s5 = $("recState"); if (s5) s5.textContent = "idle";
          console.error("PTT stop error:", err);
          try { stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
        }
      };

      state.mediaRecorder.start();
    }).catch(function (e) {
      var s6 = $("recState"); if (s6) s6.textContent = "idle";
      console.error("getUserMedia error:", e);
    });
  }

  function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      try { state.mediaRecorder.stop(); } catch (e) {}
    }
  }

  /* ==========================================================================
     DAILY (RTC) – simple hooks
  ========================================================================== */
  var createRoomBtn = $("createRoom");
  if (createRoomBtn) {
    createRoomBtn.addEventListener("click", function () {
      fetch("/api/rtc/create-room", { method: "POST" })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
          return r.json();
        })
        .then(function (j) {
          state.dailyRoom = j.room;
          state.dailyUrl = j.url;
          var info = $("roomInfo"); if (info) info.textContent = "Room: " + j.room;
        })
        .catch(function (e) {
          console.error("create room error", e);
        });
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
          .then(function (r) { return r.ok ? r.json() : {}; })
          .then(function (tok) {
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
          .catch(function (e) { console.error("token/open error", e); });
      }

      if (!state.dailyRoom) {
        // create first then open
        fetch("/api/rtc/create-room", { method: "POST" })
          .then(function (r) { if (!r.ok) throw new Error("create failed"); return r.json(); })
          .then(function (j) {
            state.dailyRoom = j.room;
            state.dailyUrl = j.url;
            var info = $("roomInfo"); if (info) info.textContent = "Room: " + j.room;
            actuallyOpen();
          })
          .catch(function (e) { console.error(e); });
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

  /* ==========================================================================
     AVATAR HOOK (optional)
  ========================================================================== */
  function feedAvatar(text) {
    var el = $("avatarFeed");
    if (el) el.textContent = (text || "").slice(0, 1200);
  }

})();
