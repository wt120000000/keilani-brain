/* chat.js — robust SSE/JSON client for Keilani Chat
   - Requires elements with ids: feed, form, input, sendBtn, model, api, token, stream, sse
   - No inline JS. Safe with your CSP. */

(() => {
  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const feed = $("feed");
  const form = $("form");
  const input = $("input");
  const sendBtn = $("sendBtn");
  const modelSel = $("model");
  const apiCtrl = $("api");
  const tokenCtrl = $("token");
  const streamChk = $("stream");
  const sseChk = $("sse");
  const rawBtn = $("rawBtn"); // optional in HTML; guarded below

  // Guard & log missing nodes (helps when HTML changes)
  const missing = [
    ["feed", feed], ["form", form], ["input", input], ["sendBtn", sendBtn],
    ["model", modelSel], ["api", apiCtrl], ["token", tokenCtrl],
    ["stream", streamChk], ["sse", sseChk],
  ].filter(([_, el]) => !el).map(([k]) => k);
  if (missing.length) {
    console.error("[chat.js] Missing UI nodes:", ...missing);
    return;
  }
  console.log("[chat.js] UI found:", {
    feed: !!feed, input: !!input, form: !!form, sendBtn: !!sendBtn,
    model: !!modelSel, api: !!apiCtrl, token: !!tokenCtrl,
    stream: !!streamChk, sse: !!sseChk
  });

  // ---------- helpers ----------
  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

  const addMsg = (role, content, opts = {}) => {
    const wrap = document.createElement("div");
    wrap.className = "msg";
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (role === "assistant" ? " assistant" : "");
    bubble.innerHTML = escapeHtml(content ?? "");
    if (opts.mono) bubble.style.fontFamily =
      'SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
    wrap.appendChild(bubble);
    feed.appendChild(wrap);
    // ensure last message visible
    bubble.scrollIntoView({ behavior: "smooth", block: "end" });
    return bubble;
  };

  const addSystemTip = (text) =>
    addMsg("assistant", text ?? "", { mono: false });

  const buildMessagesFromFeed = () => {
    // Minimal: use just the composer input; optionally you could parse the DOM to reconstruct history
    const sys = {
      role: "system",
      content:
        "You are Keilani, a helpful AI assistant. Be concise, clear, and kind.",
    };
    const user = { role: "user", content: input.value.trim() || "" };
    return [sys, user];
  };

  const headers = (clientToken, expectSSE) => {
    const h = {
      "Content-Type": "application/json",
      "Accept": expectSSE ? "text/event-stream" : "application/json",
    };
    // Pass-through client token if present (your proxy reads this)
    if (clientToken) h["X-Client-Token"] = clientToken;
    return h;
  };

  const payload = () => {
    const m = modelSel.value || "gpt-5";
    const body = {
      model: m,
      stream: !!streamChk.checked,
      messages: buildMessagesFromFeed(),
    };
    // Intentionally omit temperature for gpt-5; allow defaults
    // (If you add a slider later, gate it by model here)
    return body;
  };

  // ---------- send routines ----------
  let lastRequestMeta = null;

  const sendJSON = async () => {
    const url = apiCtrl.value.trim();
    const clientToken = tokenCtrl.value.trim();
    const wantSSE = !!sseChk.checked;
    const body = payload();

    lastRequestMeta = {
      when: new Date().toISOString(),
      url,
      wantSSE,
      body,
      headers: headers(clientToken, wantSSE),
    };

    // User bubble
    const userText = body.messages.at(-1)?.content || "";
    addMsg("user", userText);

    // Assistant bubble (target for streaming or final paste)
    const out = addMsg("assistant", "…", { mono: false });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: headers(clientToken, wantSSE),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Show full error body (often HTML or JSON) so we can see root cause
        const errText = await res.text().catch(() => "");
        out.innerHTML =
          `⚠ Upstream error (${res.status} ${res.statusText})\n\n` +
          (errText ? errText : "(empty response)");
        out.style.whiteSpace = "pre-wrap";
        return;
      }

      if (wantSSE) {
        await readSSE(res, out);
      } else {
        await readJSONorText(res, out);
      }
    } catch (e) {
      out.innerHTML = `⚠ Network error:\n\n${escapeHtml(String(e?.message || e))}`;
      out.style.whiteSpace = "pre-wrap";
    } finally {
      input.value = "";
    }
  };

  const readJSONorText = async (res, outBubble) => {
    // Try JSON first
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      const data = await res.json();
      // Support both OpenAI’s shape and a simple proxy {content:"..."}
      let text = "";
      if (data?.choices?.length) {
        const msg = data.choices[0]?.message;
        text = msg?.content ?? "";
      } else if (typeof data?.content === "string") {
        text = data.content;
      } else if (typeof data?.reply === "string") {
        text = data.reply;
      } else {
        text = JSON.stringify(data, null, 2);
        outBubble.style.whiteSpace = "pre-wrap";
      }
      outBubble.innerHTML = escapeHtml(text);
      return;
    }

    // Not JSON → fallback to text to avoid JSON.parse crashes
    const txt = await res.text();
    outBubble.innerHTML =
      `⚠ Non-JSON response (content-type: ${escapeHtml(ctype)})\n\n` +
      escapeHtml(txt.slice(0, 4000));
    outBubble.style.whiteSpace = "pre-wrap";
  };

  const readSSE = async (res, outBubble) => {
    // Stream Server-Sent Events: parse "data: ..." lines
    const reader = res.body?.getReader();
    if (!reader) {
      outBubble.textContent = "⚠ Streaming not supported in this browser.";
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "", done = false, acc = "";

    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !done });

      // Process complete lines
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (!line) continue;
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          done = true;
          break;
        }

        try {
          const obj = JSON.parse(payload);
          // OpenAI chat.completion.chunk shape
          const delta = obj?.choices?.[0]?.delta?.content ?? "";
          if (typeof delta === "string" && delta.length) {
            acc += delta;
            outBubble.textContent = acc;
          }
        } catch {
          // Some proxies may forward plain text; show it raw
          acc += payload + "\n";
          outBubble.textContent = acc;
        }
      }
    }
  };

  // ---------- wire up ----------
  const doSend = () => {
    if (!input.value.trim()) return;
    sendJSON();
  };

  sendBtn.addEventListener("click", doSend);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    doSend();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  // Utility buttons
  $("clearBtn")?.addEventListener("click", () => {
    feed.innerHTML = "";
    input.value = "";
  });
  $("resetBtn")?.addEventListener("click", () => {
    feed.innerHTML = "";
    input.value = "";
    addSystemTip("Hi! I’m here and working. What can I help you with today?\n\n• Ask a quick question\n• Summarize a paragraph\n• Generate a short code snippet\n• Translate a sentence");
  });
  $("exportBtn")?.addEventListener("click", () => {
    const text = [...feed.querySelectorAll(".bubble")]
      .map((el) => el.textContent.trim())
      .join("\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: `keilani-chat-${Date.now()}.txt` });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
  $("saveBtn")?.addEventListener("click", () => {
    const cfg = {
      api: apiCtrl.value, model: modelSel.value,
      stream: !!streamChk.checked, sse: !!sseChk.checked,
    };
    localStorage.setItem("keilani.chat.cfg", JSON.stringify(cfg));
    addSystemTip("Saved ✓");
  });

  // Raw inspector for quick debugging
  rawBtn?.addEventListener("click", () => {
    const pre = document.createElement("pre");
    pre.className = "bubble";
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = JSON.stringify(lastRequestMeta, null, 2);
    const wrap = document.createElement("div");
    wrap.className = "msg";
    wrap.appendChild(pre);
    feed.appendChild(wrap);
    pre.scrollIntoView({ behavior: "smooth", block: "end" });
  });

  // Restore saved prefs
  try {
    const cfg = JSON.parse(localStorage.getItem("keilani.chat.cfg") || "{}");
    if (cfg.api) apiCtrl.value = cfg.api;
    if (cfg.model) modelSel.value = cfg.model;
    if (typeof cfg.stream === "boolean") streamChk.checked = cfg.stream;
    if (typeof cfg.sse === "boolean") sseChk.checked = cfg.sse;
  } catch {}

  // Warm welcome
  addSystemTip("Hi! I’m here and working. What can I help you with today?\n\n• Ask a quick question\n• Summarize a paragraph\n• Generate a short code snippet\n• Translate a sentence");

  // Debug helper
  window.__send = doSend;
})();
