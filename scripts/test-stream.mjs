// node ./scripts/test-stream.mjs
const url = 'https://api.keilani.ai/api/chat-stream';
const body = JSON.stringify({
  message: 'Tell me about synthwave.',
  userId: '123e4567-e89b-12d3-a456-426614174000'
});

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body
});

if (!res.ok) {
  console.error('HTTP', res.status, res.statusText);
  console.error(await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
process.stdout.write('\n');

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });

  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const frame = buf.slice(0, i).trim();
    buf = buf.slice(i + 2);

    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') process.exit(0);
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) process.stdout.write(delta);
      } catch { /* ignore keepalives/telemetry */ }
    }
  }
}
