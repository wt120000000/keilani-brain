/* chat.js — robust hybrid SSE/JSON client for Keilani Chat
   Works with ids: feed, form, input, sendBtn, model, api, token, stream, sse, saveBtn, exportBtn, clearBtn, resetBtn, rawBtn
*/

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
  const saveBtn = $("saveBtn");
  const exportBtn = $("exportBtn");
  const clearBtn = $("clearBtn");
  const resetBtn = $("resetBtn");
  const rawBtn = $("rawBtn");

  const missing = [
    ["feed", feed], ["form", form], ["input", input], ["sendBtn", sendBtn],
    ["model", modelSel], ["api", apiCtrl], ["token", tokenCtrl],
    ["stream", streamChk], ["sse", sseChk]
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
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

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
    bubble.scrollIntoView({ behavior: "smooth", block: "end" });
    return bubble;
  };

  const addSystemTip = (text) => addMsg("assistant", text ?? "", { mono: false });

  const buildMessagesFromFeed = () => {
    const sys = { role: "system", content: "You are Keilani, a helpful AI assistant. Be concise, clear, and kind." };
    const user = { role: "user", content: input.value.trim() || "" };
    return [sys, user];
  };

  const mkHeaders = (clientToken, expectSSE) => {
    const h = {
      "Content-Type": "application/json",
      "Accept": expectSSE ? "text/event-stream" : "application/json, text/plain;q=0.6, */*;q=0.1"
    };
    if (clientToken) h["X-Client-Token"] = clientToken;
    return h;
  };

  const mkPayload = () => {
    const m = modelSel.value || "gpt-5";
    return {
      model: m,
      stream: !!streamChk.checked,
      messages: buildMessagesFromFeed(),
      // NOTE: intentionally omit temperature for gpt-5
    };
  };

  // ---------- send pipeline ----------
  let lastRequestMeta = null;

  const doSend = async () => {
    const url = apiCtrl.value.trim();
    const clientToken = tokenCtrl.value.trim();
    const wantSSE = !!sseChk.checked;
    const body = mkPayload();

    lastRequestMeta = {
      when: new Date().toISOString(),
      url,
      wantSSE,
      body,
      headers: mkHeaders(clientToken, wantSSE),
    };

    const userText = body.messages.at(-1)?.content || "";
    addMsg("user", userText);
    const out = addMsg("assistant", "…");

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: mkHeaders(clientToken, wantSSE),
        body: JSON.stringify(body),
      });

      await handleResponse(res, out);
    } catch (e) {
      out.innerHTML = `⚠ Network error:\n\n${escapeHtml(String(e?.message || e))}`;
      out.style.whiteSpace = "pre-wrap";
    } finally {
      input.value = "";
    }
  };

  const handleResponse = async (res, outBubble) => {
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      outBubble.innerHTML =
        `⚠ Upstream error (${res.status} ${res.statusText})\n\n` +
        (errText || "(empty response)");
      outBubble.style.whiteSpace = "pre-wrap";
      return;
    }

    const ctype = (res.headers.get("content-type") || "").toLowerCase();

    if (ctype.includes("text/event-stream")) {
      // Some proxies stream even when the UI toggle is off → parse as SSE
      await readSSE(res, outBubble);
      return;
    }

    if (ctype.includes("application/json")) {
      await readJSON(res, outBubble);
      return;
    }

    // Fallback: show raw text
    const txt = await res.text();
    outBubble.innerHTML =
      `⚠ Non-JSON response (content-type: ${escapeHtml(ctype)})\n\n` +
      escapeHtml(txt.slice(0, 4000));
    outBubble.style.whiteSpace = "pre-wrap";
  };

  const readJSON = async (res, outBubble) => {
    const data = await res.json().catch(() => null);

    let text = "";
    if (data?.choices?.length) {
      text = data.choices[0]?.message?.content ?? "";
    } else if (typeof data?.content === "string") {
      text = data.content;
    } else if (typeof data?.reply === "string") {
      text = data.reply;
    } else if (data) {
      text = JSON.stringify(data, null, 2);
      outBubble.style.whiteSpace = "pre-wrap";
    }

    outBubble.innerHTML = escapeHtml(text);
  };

  const readSSE = async (res, outBubble) => {
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

      // Parse complete lines
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

        // Prefer JSON chunk; fallback to raw text
        try {
          const obj = JSON.parse(payload);
          const delta = obj?.choices?.[0]?.delta?.content ?? "";
          if (typeof delta === "string" && delta.length) {
            acc += delta;
            outBubble.textContent = acc;
          }
        } catch {
          // Non-JSON data: append raw
          acc += payload + "\n";
          outBubble.textContent = acc;
        }
      }
    }
  };

  // ---------- wire up ----------
  const trySend = () => {
    if (!input.value.trim()) return;
    doSend();
  };

  sendBtn.addEventListener("click", trySend);
  form.addEventListener("submit", (e) => { e.preventDefault(); trySend(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); trySend(); }
  });

  clearBtn?.addEventListener("click", () => { feed.innerHTML = ""; input.value = ""; });

  resetBtn?.addEventListener("click", () => {
    feed.innerHTML = "";
    input.value = "";
    greet();
  });

  exportBtn?.addEventListener("click", () => {
    const text = [...feed.querySelectorAll(".bubble")]
      .map((el) => el.textContent.trim()).join("\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url, download: `keilani-chat-${Date.now()}.txt`
    });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  saveBtn?.addEventListener("click", () => {
    const cfg = {
      api: apiCtrl.value, model: modelSel.value,
      stream: !!streamChk.checked, sse: !!sseChk.checked,
    };
    localStorage.setItem("keilani.chat.cfg", JSON.stringify(cfg));
    addSystemTip("Saved ✓");
  });

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

  // restore prefs
  try {
    const cfg = JSON.parse(localStorage.getItem("keilani.chat.cfg") || "{}");
    if (cfg.api) apiCtrl.value = cfg.api;
    if (cfg.model) modelSel.value = cfg.model;
    if (typeof cfg.stream === "boolean") streamChk.checked = cfg.stream;
    if (typeof cfg.sse === "boolean") sseChk.checked = cfg.sse;
  } catch {}

  const greet = () => addSystemTip(
    "Hi! I’m here and working. What can I help you with today?\n\n" +
    "• Ask a quick question\n" +
    "• Summarize a paragraph\n" +
    "• Generate a short code snippet\n" +
    "• Translate a sentence"
  );

  greet();

  // dev helper
  window.__send = trySend;
})();
