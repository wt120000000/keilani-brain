// netlify/functions/_entitlements.js
// Minimal shim so builds never fail. Replace with real storage later.

const DEFAULT_MAX = Number(process.env.DEFAULT_MAX_MESSAGES_PER_DAY || 30);

exports.getEntitlements = async (userId) => {
  // TODO: swap to real store (Supabase, etc.)
  return {
    ent: { max_messages_per_day: DEFAULT_MAX },
    usage: { messages_used: 0 }
  };
};

exports.bumpUsage = async (userId, { messages = 1 } = {}) => {
  // TODO: increment in your real store
  return { ok: true };
};
