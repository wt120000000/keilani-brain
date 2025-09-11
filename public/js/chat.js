/* Keilani Chat front-end
 * - Streams/JSON to /api/chat
 * - Optional voice via /api/did-speak (audio-only or avatar video)
 * - Lightweight, no deps, CSP-friendly
 */

/* =========================
 *   CONFIG – UPDATE THESE
 * ========================= */
const DID_CFG = {
  // TODO: set these to your actual D-ID assets
  VOICE_ID: "REPLACE_WITH_DID_VOICE_ID", // your D-ID voice id (this is the ElevenLabs voice you added in D-ID)
  AVATAR_URL: "REPLACE_WITH_DID_AVATAR_URL", // public image/video of your avatar (png/jpg/mp4 supported by D-ID)
};

/* =========================
 *   PERSISTENCE HELPERS
 * ========================= */
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

/* =========================
 *   DOM LOOKUP (robust)
 * ========================= */
function $(sel) {
  return document.querySelector(sel);
}
function required(node, name) {
  if (!node) throw new Error(`Missing UI node: ${name}`);
  return node;
}

function uiMap() {
  // These selectors match the chat.html we shipped; if you renamed ids/classes, adjust here.
  return {
    feed: required($("#feed"), "feed"),
    input: required($("#input"), "input"),
    form: required($("#composer"), "form"),
    sendBtn: required($("#sendBtn"), "sendBtn"),

    // controls
    model: required($("#model"), "model"),
    api: required($("#api"), "api"),
    token: required($("#token"), "token"),
    stream: required($("#stream"), "stream"),
    sse: required($("#sse"), "sse"),
    // voice selector: Off | Voice | D-ID Avatar
    voice: required($("#voice"), "voice"),

    // “dock” for media; in chat.html there are hidden <audio> and <video> we can reuse
    voiceDock: required($("#voiceDock"), "voiceDock"),
    voiceAudio: required($("#voiceAudio"), "voiceAudio"),
    voiceVideo: required($("#voiceVideo"), "voiceVideo"),
  };
}

/* =========================
 *   RENDER HELPERS
 * ========================= */
function nowISO() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(
    d.getSeconds()
  )}`;
}

function bubble({ role, html, error = false }) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}${error ? " msg-error" : ""}`;
  wrap.innerHTML = html;
  return wrap;
}

function addUserBubble(feed, text) {
  const html = `
    <div class="msg-head">You <span class="muted">${nowISO()}</span></div>
    <div class="msg-body">${escapeHTML(text)}</div>
  `;
  const node = bubble({ role: "user", html });
  feed.appendChild(node);
  autoscroll(feed);
}

function addAssistantBubble(feed, html, { error = false } = {}) {
  const node = bubble({ role: "assistant", html, error });
  feed.appendChild(node);
  autoscroll(feed);
  return node;
}

function setAssistantBody(node, html) {
  const body = node.querySelector(".msg-body");
  if (body) {
    body.innerHTML = html;
  }
}

function autoscroll(feed) {
  // Only autoscroll if the user is near the bottom
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

/* =========================
 *   NETWORK HELPERS
 * ========================= */
async function postJSON(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return res;
}

async function readJSON(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    const text = await res.text();
    throw new Error(`Expected JSON, got "${ct}" with body: ${text.slice(0, 800)}`);
  }
  return res.json();
}

/* =========================
 *   SSE STREAM READER
 * ========================= */
async function readSSE(res, onChunk) {
  // For Netlify function that returns event-stream as body
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      // Expect "data: {...}" lines (could be multiple)
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("data:"))
        .forEach((dl) => {
          const json = dl.slice(5).trim();
          if (json === "[DONE]") return;
          try {
            const obj = JSON.parse(json);
            onChunk(obj);
          } catch (e) {
            // Surface the raw data if bad
            onChunk({ type: "error", error: `Bad SSE JSON chunk: ${json}` });
          }
        });
    }
  }
}

/* =========================
 *   VOICE: AUDIO & AVATAR
 * ========================= */
function ensureMediaControls(ui) {
  // Make dock visible on first use
  ui.voiceDock.hidden = false;

  // Mobile lock-screen metadata (helps persist audio while screen off)
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Keilani",
      artist: "Assistant",
      album: "Keilani",
    });
  }
}

async function speakWithDID({ text, mode }) {
  const body = {
    mode, // "voice" | "avatar"
    text,
    voice_id: DID_CFG.VOICE_ID || "",
    source_url: DID_CFG.AVATAR_URL || "",
  };
  const res = await postJSON("/api/did-speak", body);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`D-ID speak failed (${res.status}): ${errText || "no details"}`);
  }
  const data = await readJSON(res);
  if (!data.ok || !data.url) throw new Error(`D-ID speak error payload: ${JSON.stringify(data).slice(0, 500)}`);
  return data.url;
}

/* =========================
 *   MAIN SEND LOGIC
 * ========================= */
function gatherPayload(ui, msgText) {
  const messages = [
    ...(store.get("chat.messages", [])),
    { role: "user", content: msgText },
  ].slice(-20); // keep context modest

  const payload = {
    model: ui.model.value || "gpt-5",
    stream: !!ui.stream.checked,
    expectSSE: !!ui.sse.checked,
    messages,
  };

  const token = ui.token.value.trim();
  if (token) payload.client_token = token;

  return payload;
}

function persistAfterAssistant(assistantText) {
  const cur = store.get("chat.messages", []);
  cur.push({ role: "assistant", content: assistantText });
  store.set("chat.messages", cur.slice(-20));
}

function persistAfterUser(userText) {
  const cur = store.get("chat.messages", []);
  cur.push({ role: "user", content: userText });
  store.set("chat.messages", cur.slice(-20));
}

/* render + optional voice */
async function renderAssistant(ui, text, opts = {}) {
  if (!text) return;

  // final text bubble
  const node = addAssistantBubble(ui.feed, `
    <div class="msg-head">Keilani <span class="muted">${nowISO()}</span></div>
    <div class="msg-body">${escapeHTML(text)}</div>
  `);

  persistAfterAssistant(text);

  // Voice mode
  const mode = (ui.voice.value || "off").toLowerCase();
  if (mode === "off") return;

  try {
    ensureMediaControls(ui);
    if (mode === "voice") {
      const url = await speakWithDID({ text, mode: "voice" });
      ui.voiceAudio.src = url;
      ui.voiceAudio.play().catch(() => {});
    } else if (mode === "avatar") {
      const url = await speakWithDID({ text, mode: "avatar" });
      ui.voiceVideo.src = url;
      ui.voiceVideo.play().catch(() => {});
    }
  } catch (err) {
    const errHtml = `<div class="msg-body"><span class="muted">Voice error:</span> ${escapeHTML(err.message || String(err))}</div>`;
    const errNode = bubble({ role: "assistant", html: errHtml, error: true });
    ui.feed.appendChild(errNode);
    autoscroll(ui.feed);
  }
}

/* =========================
 *   APP BOOT
 * ========================= */
function boot() {
  const ui = uiMap();

  // Restore persisted
  ui.api.value = store.get("chat.api", "/api/chat");
  ui.model.value = store.get("chat.model", "gpt-5");
  ui.stream.checked = store.get("chat.stream", true);
  ui.sse.checked = store.get("chat.sse", true);
  ui.voice.value = store.get("chat.voice", "off");
  ui.token.value = store.get("chat.client_token", "");

  // Render last few messages (if any)
  const hist = store.get("chat.messages", []);
  if (hist.length) {
    hist.forEach((m) => {
      if (m.role === "user") {
        addUserBubble(ui.feed, m.content);
      } else if (m.role === "assistant") {
        addAssistantBubble(
          ui.feed,
          `<div class="msg-head">Keilani <span class="muted">${nowISO()}</span></div><div class="msg-body">${escapeHTML(
            m.content
          )}</div>`
        );
      }
    });
  } else {
    // Starter
    addAssistantBubble(
      ui.feed,
      `<div class="msg-head">Keilani <span class="muted">${nowISO()}</span></div>
       <div class="msg-body">Hi! I’m here and working. What can I help you with today? 
        • Ask a quick question • Summarize a paragraph • Generate a short code snippet • Translate a sentence</div>`
    );
  }

  // Persist control changes
  ui.api.addEventListener("change", () => store.set("chat.api", ui.api.value.trim()));
  ui.model.addEventListener("change", () => store.set("chat.model", ui.model.value));
  ui.stream.addEventListener("change", () => store.set("chat.stream", !!ui.stream.checked));
  ui.sse.addEventListener("change", () => store.set("chat.sse", !!ui.sse.checked));
  ui.voice.addEventListener("change", () => store.set("chat.voice", ui.voice.value));
  ui.token.addEventListener("change", () => store.set("chat.client_token", ui.token.value.trim()));

  // ENTER/Shift+ENTER
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(ui).catch(console.error);
    }
  });
  ui.sendBtn.addEventListener("click", () => send(ui).catch(console.error));

  console.log("[chat.js] UI ready. Tip: call window.__send() in console to force a send.");
  window.__send = () => send(ui);
}

/* =========================
 *   SEND HANDLER
 * ========================= */
async function send(ui) {
  const text = ui.input.value.trim();
  if (!text) return;

  // add user bubble
  addUserBubble(ui.feed, text);
  persistAfterUser(text);
  ui.input.value = "";

  // placeholder assistant node
  const aNode = addAssistantBubble(
    ui.feed,
    `<div class="msg-head">Keilani <span class="muted">${nowISO()}</span></div><div class="msg-body">…</div>`
  );

  const payload = gatherPayload(ui, text);
  const ctrl = new AbortController();
  let finalText = "";

  try {
    const res = await postJSON(ui.api.value.trim() || "/api/chat", payload, ctrl.signal);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} — ${errBody.slice(0, 1200)}`);
    }

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    // STREAM (SSE-like) or JSON
    if (ct.includes("text/event-stream")) {
      // stream deltas
      await readSSE(res, (chunk) => {
        // Expect OpenAI-style chunk: { choices:[{ delta:{ content:"..."}}]}
        if (chunk?.choices?.[0]?.delta?.content) {
          finalText += chunk.choices[0].delta.content;
          setAssistantBody(aNode, escapeHTML(finalText));
        } else if (chunk?.type === "error") {
          setAssistantBody(aNode, `<span class="muted">${escapeHTML(chunk.error)}</span>`);
        }
      });

      // voice + persist after stream finishes
      await renderAssistant(ui, finalText);
      aNode.remove(); // replace the streamed node with final one (renderAssistant added)
    } else {
      // JSON mode
      const data = await readJSON(res);
      // Expect OpenAI-style response: choices[0].message.content
      finalText = data?.choices?.[0]?.message?.content ?? "";
      if (!finalText) {
        setAssistantBody(
          aNode,
          `<span class="muted">No content in response.</span><br/><pre>${escapeHTML(
            JSON.stringify(data, null, 2).slice(0, 2000)
          )}</pre>`
        );
        return;
      }

      // replace node with final + voice
      aNode.remove();
      await renderAssistant(ui, finalText);
    }
  } catch (err) {
    setAssistantBody(
      aNode,
      `<span class="muted">Error:</span> ${escapeHTML(err.message || String(err))}`
    );
  }
}

/* =========================
 *   BOOT
 * ========================= */
document.addEventListener("DOMContentLoaded", () => {
  try {
    boot();
  } catch (e) {
    console.error(e);
    alert(e.message);
  }
});
