// Extracted from index.html (CSP-safe). Non-stream JSON chat + local TTS.

const sendBtn = document.getElementById("send");
const msgEl = document.getElementById("message");
const userEl = document.getElementById("userId");
const statusEl = document.getElementById("status");
const replyEl = document.getElementById("reply");
const matchesEmpty = document.getElementById("matchesEmpty");
const matchesTable = document.getElementById("matchesTable");
const matchesBody = document.getElementById("matchesBody");
const thresholdEl = document.getElementById("threshold");
const countEl = document.getElementById("count");
const skipContextEl = document.getElementById("skipContext");

const healthBadge = document.getElementById("healthBadge");
const healthDot = document.getElementById("healthDot");
const healthText = document.getElementById("healthText");
const healthRefresh = document.getElementById("healthRefresh");

// TTS controls
const voiceSel = document.getElementById("voice");
const rateEl = document.getElementById("rate");
const pitchEl = document.getElementById("pitch");
const toggleTTSBtn = document.getElementById("toggleTTS");

// ---------- State ----------
let ttsEnabled = true;
let voices = [];
let selectedVoice = null;

function setStatus(s) { statusEl.textContent = s; }

// ---------- HEALTH ----------
async function refreshHealth() {
  try {
    healthText.textContent = "checking…";
    healthDot.className = "dot";
    const resp = await fetch("/api/health", { cache: "no-store" });
    const ok = await resp.json();
    const allTrue =
      ok.has_OPENAI_API_KEY &&
      ok.has_OPENAI_MODEL &&
      ok.has_EMBED_MODEL &&
      ok.has_SUPABASE_URL &&
      ok.has_SUPABASE_SERVICE_ROLE;
    healthDot.className = "dot " + (allTrue ? "ok" : "warn");
    healthText.textContent = allTrue ? "OK" : "Degraded";
    healthBadge.title = JSON.stringify(ok, null, 2);
  } catch (e) {
    healthDot.className = "dot err";
    healthText.textContent = "Error";
    healthBadge.title = e.message;
  }
}
healthRefresh.addEventListener("click", refreshHealth);
refreshHealth();
setInterval(refreshHealth, 30000);

// ---------- TTS ----------
function populateVoices() {
  voices = (window.speechSynthesis?.getVoices?.() || []).filter((v) => v.lang?.startsWith?.("en"));
  voiceSel.innerHTML =
    voices.map((v, i) => `<option value="${i}">${v.name} (${v.lang})${v.default ? " — default" : ""}</option>`).join("")
    || `<option value="">(No voices found)</option>`;
  selectedVoice = voices[0] || null;
}
if ("speechSynthesis" in window) {
  populateVoices();
  window.speechSynthesis.onvoiceschanged = populateVoices;
}

function speakAsKeilani(text) {
  if (!ttsEnabled) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  if (selectedVoice) utter.voice = selectedVoice;
  const rate = Math.min(2, Math.max(0.5, Number(rateEl.value) || 1.0));
  const pitch = Math.min(2, Math.max(0, Number(pitchEl.value) || 1.0));
  utter.rate = rate; utter.pitch = pitch;
  window.speechSynthesis.speak(utter);
}
voiceSel.addEventListener("change", (e) => {
  const idx = Number(e.target.value);
  selectedVoice = voices[idx] || null;
});
toggleTTSBtn.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  toggleTTSBtn.textContent = ttsEnabled ? "🔊 TTS: On" : "🔇 TTS: Off";
  toggleTTSBtn.classList.toggle("secondary", true);
});

// ---------- Chat ----------
async function sendToKeilani(message) {
  const threshold = Number(thresholdEl.value || 0.6);
  const count = Number(countEl.value || 8);
  const skip = skipContextEl.checked;

  const qs = new URLSearchParams();
  if (skip) qs.set("nocontext", "1");
  else { qs.set("threshold", String(threshold)); qs.set("count", String(count)); }

  const url = `/api/chat?${qs.toString()}`;
  const body = { userId: userEl.value || "00000000-0000-0000-0000-000000000001", message };

  setStatus("thinking…");
  sendBtn.disabled = true;

  try {
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await resp.json();

    if (!resp.ok) {
      replyEl.textContent = `⚠️ ${data.error || "Chat error"}`;
      matchesEmpty.style.display = "block";
      matchesTable.style.display = "none";
      return;
    }

    replyEl.textContent = data.reply || "—";
    speakAsKeilani(data.reply || "");

    const matches = Array.isArray(data.matches) ? data.matches : [];
    if (matches.length === 0) {
      matchesEmpty.style.display = "block";
      matchesTable.style.display = "none";
    } else {
      matchesEmpty.style.display = "none";
      matchesTable.style.display = "";
      matchesBody.innerHTML = matches
        .map((m) => `<tr><td>${escapeHtml(m.title || "")}</td><td>${escapeHtml(m.source || "")}</td><td>${Number(m.similarity || 0).toFixed(3)}</td></tr>`)
        .join("");
    }
  } catch (e) {
    replyEl.textContent = `⚠️ Network error: ${e.message}`;
    matchesEmpty.style.display = "block";
    matchesTable.style.display = "none";
  } finally {
    setStatus("idle");
    sendBtn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

sendBtn.addEventListener("click", () => {
  const msg = msgEl.value.trim();
  if (!msg) return;
  sendToKeilani(msg);
  msgEl.value = "";
  msgEl.focus();
});

msgEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    sendBtn.click();
  }
});
