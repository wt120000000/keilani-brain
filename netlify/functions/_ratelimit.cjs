// CJS version for functions written in CommonJS.
const buckets = new Map(); // ip -> { tokens, updated }

function allow(ip, { capacity = 20, refillPerSec = 1 } = {}) {
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: capacity, updated: now };
  const elapsed = (now - b.updated) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
  b.updated = now;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1; buckets.set(ip, b); return true;
}
module.exports = { allow };
