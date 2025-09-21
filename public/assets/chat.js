// public/assets/chat.js

let autoListenEnabled = false;

// hold-lines
const HOLDS = [
  "Gimme a sec…",
  "One moment…",
  "Lemme check…",
  "Hang on…",
  "Umm… checking…"
];

function maybeHoldLine(startTs) {
  const now = performance.now();
  if (now - startTs < 800) return;
  const msg = HOLDS[Math.floor(Math.random() * HOLDS.length)];
  speak(msg, { speed: 1.06 });
}

async function askLLM(userText) {
  const t0 = performance.now();
  const holdTimer = setTimeout(() => maybeHoldLine(t0), 800);

  try {
    const r = await fetch("/.netlify/functions/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userText })
    });
    clearTimeout(holdTimer);
    if (!r.ok) throw new Error("chat function failed");
    const data = await r.json();
    if (data.reply) await speak(data.reply);
  } catch (err) {
    clearTimeout(holdTimer);
    console.error("chat error", err);
    await speak("Sorry, I had trouble just now.");
  }
  // ... inside askLLM(text)
  let saidFiller = false;
  const fillerTimer = setTimeout(() => {
  // Only speak a filler if the backend is taking > 900ms
    saidFiller = true;
    const fillers = ["Gimme a sec…", "hang on…", "one moment…", "lemme check…"];
    const say = fillers[Math.floor(Math.random() * fillers.length)];
    speak(say, { speed: 1.05 });
	}, 900);

  const res = await fetch("/.netlify/functions/chat", { /* ... */ });
// ...
  clearTimeout(fillerTimer);
// do NOT speak another filler; continue with TTS of real reply

}

async function speak(text, opts = {}) {
  try {
    const r = await fetch("/.netlify/functions/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...opts })
    });
    if (!r.ok) throw new Error("TTS failed");
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    await new Promise((res) => {
      audio.onended = res;
      audio.play();
    });

    if (autoListenEnabled) startRecording();
  } catch (err) {
    console.error("speak error", err);
  }
}

// STT + recording (simplified)
async function startRecording() {
  // your existing recording logic stays
}

// wire UI buttons
document.querySelector("#startBtn")?.addEventListener("click", () => {
  autoListenEnabled = true;
  startRecording();
});
document.querySelector("#stopBtn")?.addEventListener("click", () => {
  autoListenEnabled = false;
});
