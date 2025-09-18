// chat.js
// Handles audio recording and posting to Netlify STT function

// chat.js (very first line)
console.log("CHAT.JS BUILD TAG → 2025-09-18T08:45-0700");

let mediaRecorder = null;
let chunks = [];

// Start microphone capture and recording
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Prefer webm (whisper handles it fine)
    const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/ogg;codecs=opus';

    mediaRecorder = new MediaRecorder(stream, { mimeType: preferredMime });
    chunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        chunks.push(e.data);
        console.log('[STT] chunk collected, bytes=', e.data.size);
      }
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: preferredMime });
      console.log('[STT] final blob', blob.type, blob.size, 'bytes');

      if (blob.size < 8192) {
        console.warn('[STT] too small, record longer before stopping');
        return;
      }

      const base64 = await blobToBase64Raw(blob);

      const body = {
        audioBase64: base64,
        language: 'en',
        mime: blob.type,
        filename: blob.type.includes('webm')
          ? 'audio.webm'
          : blob.type.includes('ogg')
          ? 'audio.ogg'
          : 'audio.wav',
      };

      try {
        const res = await fetch('https://api.keilani.ai/.netlify/functions/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const json = await res.json().catch(() => ({}));
        console.log('[STT] response', res.status, json);
      } catch (err) {
        console.error('[STT] fetch error', err);
      }
    };

    mediaRecorder.start();
    console.log('[STT] recording started');
  } catch (err) {
    console.error('[STT] mic error', err);
  }
}

// Stop recording and trigger upload
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    console.log('[STT] recording stopped');
  }
}

// Utility: convert Blob → raw base64 (no data URL prefix)
function blobToBase64Raw(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = reader.result || '';
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Export functions to your UI (buttons or chat logic)
window.startRecording = startRecording;
window.stopRecording = stopRecording;
