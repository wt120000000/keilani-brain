// public/js/chat.js
(() => {
  const LS_KEY = "keilani.chat.v3";
  const $ = (sel) => document.querySelector(sel);

  // ---- UI wiring -----------------------------------------------------------
  const ui = {
    feed:    $("#feed"),
    input:   $("#input"),
    form:    $("#form"),
    sendBtn: $("#sendBtn"),
    model:   $("#model"),
    api:     $("#api"),
    token:   $("#token"),
    stream:  $("#stream"),
    sse:     $("#sse"),
  };

  // Validate required nodes
  const missing = Object.entries(ui)
    .filter(([, node]) => !node)
    .map(([k]) => k);
  if (missing.length) {
    console.error("[chat.js] Missing UI nodes:", missing.join(", "));
    return;
  }

  // ---- tiny helpers --------------------------------------------------------
  const log = (...a) => console.log("[chat.js]", ...a);
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  function bubble(role, text, opts = {}) {
    const outer = document.createElement("div");
    outer.className = `msg ${role}`;
    outer.setAttribute("data-ts", now());

    const inner = document.createElement("div");
    inner.className = "msg-bubble";

    if (opts.rawHtml) {
      inner.innerHTML = text;
    } else {
      // keep it safe + simple
      inner.innerHTML = esc(text).replace(/\n/g, "<br/>");
    }

    outer.appendChild(inner);
    ui.feed.appendChild(outer);
    ui.feed.scrollTop = ui.feed.scrollHeight;
    return inner; // allow incremental streaming append
  }

  function saveState() {
    const data = {
      api: ui.api.value.trim(),
      token: ui.token.value.trim(),
      model: ui.model.value,
      stream: !!ui.stream.checked,
      sse: !!ui.sse.checked,
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {}
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.api) ui.api.value = s.api;
      if (s.token) ui.token.value = s.token;
      if (s.model) ui.model.value = s.model;
      if (typeof s.stream === "boolean") ui.stream.checked = s.stream;
      if (typeof s.sse === "boolean") ui.sse.checked = s.sse;
    } catch {}
  }

  // ---- network helpers -----------------------------------------------------
  // Non-SSE JSON path
  async function fetchJSON(endpoint, payload) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Try OpenAI-style first
    if (data?.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    // Some proxies return { content: "..." }
    if (typeof data?.content === "string") {
      return data.content;
    }
    // Netlify function may wrap as { success, data: { choices... } }
    if (data?.data?.choices?.[0]?.message?.content) {
      return data.data.choices[0].message.content;
    }
    // Fallback: pretty print
    return JSON.stringify(data, null, 2);
  }

  // Streaming via SSE-compatible response (server sends "data: {json}\n\n")
  async function fetchStream(endpoint, payload, onDelta, onDone) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Expect text/event-stream, but we'll be tolerant and parse "data:" lines
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // split by SSE frame separator
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);

        // Only handle data: lines
        const lines = frame.split("\n").filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            onDone?.();
            return;
          }
          try {
            const json = JSON.parse(payload);
            // OpenAI-style chunk
            const delta = json?.choices?.[0]?.delta?.content ?? "";
            if (delta) onDelta(delta);
            // Some backends send { content: "..." } directly
            if (!delta && typeof json?.content === "string") onDelta(json.content);
          } catch {
            // tolerate non-JSON data lines (debug frames)
            if (payload) onDelta(payload + "\n");
          }
        }
      }
    }
    onDone?.();
  }

  // ---- send flow -----------------------------------------------------------
  async function send(message) {
    const endpoint = ui.api.value.trim();
    if (!endpoint) return bubble("assistant", "⚠️ Please set the API endpoint first.");

    const model = ui.model.value;
    const clientToken = ui.token.value.trim();
    const stream = !!ui.stream.checked;
    const expectSSE = !!ui.sse.checked;

    // user bubble
    bubble("user", message);

    // payload matches our Netlify/OpenAI proxy
    const payload = {
      model,
      stream,
      client_token: clientToken || undefined,
      // minimal OpenAI-style messages array
      messages: [{ role: "user", content: message }],
    };

    log("POST", endpoint, { stream, expectSSE });
    saveState();

    // assistant bubble placeholder for streaming or final reply
    const slot = bubble("assistant", expectSSE ? "…" : "");

    try {
      if (expectSSE) {
        // STREAMING
        await fetchStream(
          endpoint,
          payload,
          (delta) => {
            slot.innerHTML += esc(delta).replace(/\n/g, "<br/>");
            ui.feed.scrollTop = ui.feed.scrollHeight;
          },
          () => {
            // done
          }
        );
      } else {
        // JSON (non-SSE)
        const text = await fetchJSON(endpoint, payload);
        slot.innerHTML = esc(text).replace(/\n/g, "<br/>");
      }
    } catch (err) {
      slot.innerHTML = `⚠️ ${esc(err.message || String(err))}`;
    }
  }

  // ---- events & boot -------------------------------------------------------
  function wire() {
    // Enter = send; Shift+Enter = newline
    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (ui.input.value.trim()) {
          const m = ui.input.value.trim();
          ui.input.value = "";
          send(m);
        }
      }
    });

    ui.sendBtn.addEventListener("click", () => {
      if (!ui.input.value.trim()) return;
      const m = ui.input.value.trim();
      ui.input.value = "";
      send(m);
    });

    // persist on changes
    [ui.api, ui.token, ui.model, ui.stream, ui.sse].forEach((n) =>
      n.addEventListener("change", saveState)
    );

    // expose a console helper for quick tests
    window.__send = (m) => send(m || ui.input.value.trim());

    // greet
    if (!ui.feed.querySelector(".msg")) {
      bubble(
        "assistant",
        "Hi! I’m here and working. What can I help you with today?\n\n• Ask a quick question\n• Summarize a paragraph\n• Generate a short code snippet\n• Translate a sentence"
      );
    }
  }

  loadState();
  wire();
  log("UI found:", Object.fromEntries(Object.entries(ui).map(([k, v]) => [k, !!v])));
  log("Ready. Tip: call window.__send() in console to force a send.");
})();
