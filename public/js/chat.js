/* public/js/chat.js
   Keilani Chat – solid client with SSE + JSON, resilient UI wiring, and clean messages[]
*/

(() => {
  "use strict";

  // -------- Helpers ---------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const log = (...a) => console.log("[chat.js]", ...a);
  const warn = (...a) => console.warn("[chat.js]", ...a);
  const err = (...a) => console.error("[chat.js]", ...a);

  const storage = {
    get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} }
  };

  const nowISO = () => new Date().toISOString().slice(0,19).replace("T", " ");

  // Extract content from possible JSON shapes
  const pickContent = (obj) => {
    if (!obj || typeof obj !== "object") return "";
    // OpenAI-ish
    if (obj.choices?.[0]?.message?.content) return obj.choices[0].message.content;
    if (obj.choices?.[0]?.delta?.content) return obj.choices[0].delta.content;
    // Our proxy shape
    if (obj.message?.content) return obj.message.content;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.reply === "string") return obj.reply;
    // Fallback
    return "";
  };

  // -------- UI wiring (robust / selector-flexible) --------------------------
  function findUI() {
    // Feed/message container – try common candidates
    const feed = $("#feed") || $(".feed") || $(".main") || $(".messages") || $("main") || $("#app");

    // Composer input (textarea)
    const input =
      $("#composer") || $(".composer textarea") || $("textarea") ||
      $("#message") || $(".input textarea");

    // Form wrapper (optional)
    const form = input?.closest("form") || $("#form") || $(".composer") || null;

    // Send button – try a few options
    const sendBtn =
      $("#send") || $(".send") ||
      $all("button").find(b => /send/i.test(b.textContent || "")) ||
      null;

    // Controls
    const apiCtrl   = $("#api")    || $("input[name='api']")    || $("input[type='url']");
    const tokenCtrl = $("#token")  || $("input[name='token']")  || $("input[placeholder*='Client']");
    const modelCtrl = $("#model")  || $("select[name='model']") || $("select");
    const streamCtrl = $("#stream") || $("input[name='stream']") || $("input[type='checkbox']#stream");
    const sseCtrl    = $("#expectSSE") || $("input[name='expectSSE']") ||
                       $("input[type='checkbox'][id*='expect']");

    return { feed, input, form, sendBtn, apiCtrl, tokenCtrl, modelCtrl, streamCtrl, sseCtrl };
  }

  // Make a message bubble
  function bubbleHTML(role, content) {
    const who = role === "user" ? "You" : "Keilani";
    return `
      <section class="msg ${role}">
        <div class="row">
          <div class="bubble">
            <div class="meta">
              <strong>${who}</strong>
              <span class="ts">${nowISO()}</span>
            </div>
            <div class="content">${escapeHTML(content)}</div>
          </div>
        </div>
      </section>
    `;
  }

  function escapeHTML(s) {
    return (s ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function appendMsg(feed, role, text) {
    if (!feed) return;
    feed.insertAdjacentHTML("beforeend", bubbleHTML(role, text));
    feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  }

  function appendTyping(feed) {
    if (!feed) return null;
    const host = document.createElement("section");
    host.className = "msg assistant typing";
    host.innerHTML = `
      <div class="row">
        <div class="bubble">
          <div class="meta">
            <strong>Keilani</strong>
            <span class="ts">${nowISO()}</span>
          </div>
          <div class="content"><em>…</em></div>
        </div>
      </div>
    `;
    feed.appendChild(host);
    feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
    return host.querySelector(".content");
  }

  // Build messages history from the feed (simple text scrape by role classes)
  function scrapeHistory(feed) {
    // If your page already stores conversation elsewhere, replace with that source of truth
    const msgs = [];
    $all(".msg.user .content", feed).forEach(el => {
      msgs.push({ role: "user", content: el.textContent.trim() });
    });
    $all(".msg.assistant .content", feed).forEach(el => {
      msgs.push({ role: "assistant", content: el.textContent.trim() });
    });
    return msgs;
  }

  // -------- Networking -------------------------------------------------------
  async function postJSON(api, body, headers) {
    const res = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return res;
  }

  async function readStreamTo(el, res, onFinalText) {
    // Robust SSE-ish line reader
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Split on newlines; handle 'data:' lines if present
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (!line) continue;

        let chunkText = "";
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") break;
          try {
            const j = JSON.parse(data);
            chunkText = pickContent(j);
          } catch {
            // raw text chunk
            chunkText = data;
          }
        } else {
          // raw text line (no SSE prefix)
          chunkText = line;
        }

        if (chunkText) {
          if (el) el.innerHTML += escapeHTML(chunkText);
        }
      }
    }
    // Flush remainder (if any)
    if (buf.trim()) {
      try {
        const j = JSON.parse(buf.trim());
        const tail = pickContent(j);
        if (tail && el) el.innerHTML += escapeHTML(tail);
        if (tail && onFinalText) onFinalText(tail);
      } catch {
        if (el) el.innerHTML += escapeHTML(buf.trim());
      }
    }
  }

  // -------- Main controller --------------------------------------------------
  function init() {
    const ui = findUI();

    // Guard: show a helpful console dump once
    log("UI found:", {
      feed: !!ui.feed, input: !!ui.input, sendBtn: !!ui.sendBtn, form: !!ui.form,
      apiCtrl: !!ui.apiCtrl, modelCtrl: !!ui.modelCtrl, tokenCtrl: !!ui.tokenCtrl,
      streamCtrl: !!ui.streamCtrl, sseCtrl: !!ui.sseCtrl
    });

    if (!ui.feed || !ui.input) {
      err("Required elements missing (feed/input). Aborting init.");
      return;
    }

    // Prefill from localStorage
    if (ui.apiCtrl)   ui.apiCtrl.value   = storage.get("chat.api",   ui.apiCtrl.value || "https://api.keilani.ai/api/chat");
    if (ui.modelCtrl) ui.modelCtrl.value = storage.get("chat.model", ui.modelCtrl.value || "gpt-5");
    if (ui.tokenCtrl) ui.tokenCtrl.value = storage.get("chat.token", ui.tokenCtrl.value || "");
    if (ui.streamCtrl) ui.streamCtrl.checked = storage.get("chat.stream", "1") === "1";
    if (ui.sseCtrl)    ui.sseCtrl.checked    = storage.get("chat.expectSSE", "1") === "1";

    // Persist on change
    ui.apiCtrl?.addEventListener("change", e => storage.set("chat.api", e.target.value.trim()));
    ui.modelCtrl?.addEventListener("change", e => storage.set("chat.model", e.target.value));
    ui.tokenCtrl?.addEventListener("change", e => storage.set("chat.token", e.target.value.trim()));
    ui.streamCtrl?.addEventListener("change", e => storage.set("chat.stream", e.target.checked ? "1" : "0"));
    ui.sseCtrl?.addEventListener("change", e => storage.set("chat.expectSSE", e.target.checked ? "1" : "0"));

    // Send function
    async function send() {
      const text = (ui.input.value || "").trim();
      if (!text) return;

      const api = ui.apiCtrl?.value?.trim() || "https://api.keilani.ai/api/chat";
      const model = ui.modelCtrl?.value || "gpt-5";
      const token = ui.tokenCtrl?.value?.trim();
      const stream = !!ui.streamCtrl?.checked;
      const expectSSE = !!ui.sseCtrl?.checked;

      // Append user bubble
      appendMsg(ui.feed, "user", text);
      ui.input.value = "";

      // Assistant “typing” placeholder
      const contentEl = appendTyping(ui.feed);

      // Build history (messages[])
      const history = scrapeHistory(ui.feed);
      // Push the current user turn too (since we just appended it visually)
      if (!history.length || history[history.length - 1].content !== text) {
        history.push({ role: "user", content: text });
      }

      // Build payload – only messages[]
      const payload = {
        model,
        stream,
        messages: history
      };

      const headers = {
        "X-Client-Token": token || "",
      };
      // Some proxies also accept Bearer – harmless to include if token present
      if (token) headers["Authorization"] = `Bearer ${token}`;

      log("POST", api, { stream, expectSSE });

      try {
        const res = await postJSON(api, payload, headers);
        const ctype = (res.headers.get("content-type") || "").toLowerCase();

        if (!res.ok) {
          const msg = await res.text();
          throw new Error(`HTTP ${res.status} – ${msg}`);
        }

        if (stream && expectSSE && res.body) {
          // Streaming mode
          await readStreamTo(contentEl, res, null);
        } else if (ctype.includes("application/json")) {
          // One-shot JSON
          const data = await res.json();
          const reply = pickContent(data) || JSON.stringify(data);
          if (contentEl) contentEl.innerHTML = escapeHTML(reply);
        } else {
          // Fallback: treat as text
          const txt = await res.text();
          if (contentEl) contentEl.innerHTML = escapeHTML(txt);
        }
      } catch (e) {
        if (contentEl) {
          contentEl.innerHTML = `<span class="err">[Error] ${escapeHTML(e.message || String(e))}</span>`;
        }
        err(e);
      }
    }

    // Wire send button and Enter
    if (ui.sendBtn) {
      ui.sendBtn.addEventListener("click", () => {
        log("Click send button -> send");
        send();
      }, { passive: true });
    }

    if (ui.input) {
      ui.input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          log("keydown Enter -> send");
          send();
        }
      });
    }

    // Expose debug hook
    window.__send = send;

    // MutationObserver – just to keep pointers valid if DOM rebuilds,
    // but NEVER unset once we have them (prevents flipping false).
    const mo = new MutationObserver(() => {
      const latest = findUI();
      // Only set if previously null and now found
      for (const k of Object.keys(ui)) {
        if (!ui[k] && latest[k]) ui[k] = latest[k];
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    log("Ready. Tip: call window.__send() in console to force a send.");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
