// netlify/functions/chat.js
// CommonJS Netlify v1 handler (event, context) -> { statusCode, headers, body }
// SDK-free; uses global fetch.

function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
const ok = (o) => json(200, o);

function systemPrompt() {
  return `
You are **Keilani** — warm, on-point, and practical. Match the user's tone naturally.
Style: concise (4–8 sentences), specific, lightly opinionated. One subtle compliment max.

IF SEARCH MATERIAL IS PROVIDED:
- Use it. Name exact items/characters/features and call out 1–2 standouts.
- Add short parenthetical tags like (Epic patch notes), (IGN), (GameSpot). No raw URLs.

IF UNCERTAIN:
- Say what's known + what you'd verify next.
- Do NOT imply you browsed if no search bundle is provided.
`.trim();
}

function buildUserContent(message, searchBundle, userId) {
  if (!searchBundle) return `${message}\n\nUserID: ${userId}`;
  const items = (searchBundle.results || searchBundle.news || []).slice(0, 6);
  const lines = [];
  if (searchBundle.answer) lines.push(`Search synthesis:\n${searchBundle.answer}`);
  if (items.length) {
    lines.push("Key items:");
    for (const it of items) {
      const title = it.title || it.source || "result";
      const src = it.source || "";
      const url = it.url || it.link || "";
      lines.push(`- ${title}${src ? ` — ${src}` : ""}${url ? ` — ${url}` : ""}`);
    }
  }
  lines.push("");
  lines.push(`User asked: ${message}`);
  lines.push(
    "Write a SPECIFIC answer grounded in items above. For Fortnite: list named skins/characters, LTM/modes, unique mechanics or weapons (2–4 bullets or tight paragraphs). Include a brief opinion and add parenthetical source tags like (Epic patch notes), (IGN)."
  );
  lines.push(`UserID: ${userId}`);
  return lines.join("\n");
}

function pickCitations(s) {
  const items = s?.results || s?.news || [];
  return items.slice(0, 3).map((it) => ({
    title: it.title || it.source || "source",
    url: it.url || it.link || "",
  }));
}

function nextEmotion(prev, msg) {
  const neutral = { stability: 0.6, similarity: 0.7, style: 0.4 };
  try {
    const m = String(msg || "").toLowerCase();
    if (/\b(awesome|great|nice|love|dope|fire|let's go|hype)\b/.test(m)) {
      return { stability: 0.65, similarity: 0.75, style: 0.5 };
    }
    if (/\b(sad|ugh|annoy|mad|angry|frustrat|confus)\b/.test(m)) {
      return { stability: 0.7, similarity: 0.6, style: 0.25 };
    }
    return prev || neutral;
  } catch {
    return prev || neutral;
  }
}

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    const body = JSON.parse(event.body || "{}");
    const user_id = typeof body.user_id === "string" && body.user_id.trim() ? body.user_id.trim() : "global";
    const message = typeof body.message === "string" ? body.message : "";
    const emotion_state = body.emotion_state || null;

    if (!message.trim()) {
      return ok({ error: "missing_message" });
    }

    // Heuristic: decide when to search
    const m = message.toLowerCase();
    const shouldSearch =
      m.startsWith("search:") ||
      /\b(today|this week|latest|right now|breaking|patch notes|update)\b/.test(m) ||
      /\b(look it up|can you check|what changed|find out)\b/.test(m);

    let searchBundle = null;
    if (shouldSearch) {
      const q = m.startsWith("search:")
        ? message.replace(/^search:\s*/i, "")
        : `${message} site:fortnite.com OR site:epicgames.com OR site:ign.com OR site:gamespot.com OR site:polygon.com`;

      const base =
        process.env.URL ||
        process.env.SITE_URL ||
        (context && context.site && context.site.url) ||
        "";

      const searchUrl = base
        ? `${base}/.netlify/functions/search`
        : "/.netlify/functions/search";

      try {
        const sRes = await fetch(searchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ q, max: 6, fresh: true }),
        });
        if (sRes.ok) {
          const sData = await sRes.json().catch(() => ({}));
          if (sData?.results?.length || sData?.news?.length || sData?.answer) {
            searchBundle = sData;
          }
        }
      } catch {}
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
    const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (!OPENAI_API_KEY) {
      // Offline fallback
      const reply = searchBundle?.answer
        ? searchBundle.answer
        : `Here's a quick take: ${message}`;
      return ok({
        reply,
        next_emotion_state: nextEmotion(emotion_state, message),
        meta: { searched: !!searchBundle, offline: true, user_id },
      });
    }

    const payload = {
      model: OPENAI_MODEL,
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.5),
      max_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 520),
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: buildUserContent(message, searchBundle, user_id) },
      ],
    };

    const oai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!oai.ok) {
      const err = await oai.text();
      const fallback = searchBundle?.answer || "I couldn’t load the model just now.";
      return ok({ reply: fallback, meta: { searched: !!searchBundle, openai_error: err, user_id } });
    }

    const data = await oai.json().catch(() => ({}));
    const reply =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim() ||
      (searchBundle?.answer || "Got it.");

    return ok({
      reply,
      next_emotion_state: nextEmotion(emotion_state, message),
      meta: { searched: !!searchBundle, citations: pickCitations(searchBundle), user_id },
    });
  } catch (err) {
    return ok({ error: "chat_unhandled", detail: String(err) });
  }
};
