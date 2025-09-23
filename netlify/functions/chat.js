// netlify/functions/chat.js
// CommonJS, SDK-free, Node 18+ (global fetch). Grounded, stylish summaries.

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  };
}

function shouldSearch(text) {
  if (!text) return false;
  const s = text.toLowerCase();
  return (
    s.startsWith("search:") ||
    s.includes("today") ||
    s.includes("this week") ||
    s.includes("latest") ||
    s.includes("new update") ||
    s.includes("patch notes") ||
    s.includes("what changed")
  );
}

function getBase(event) {
  return (
    process.env.URL ||
    process.env.SITE_URL ||
    (event?.headers?.["x-forwarded-host"] ? `https://${event.headers["x-forwarded-host"]}` : null) ||
    "https://api.keilani.ai"
  );
}

function briefResults(bundle) {
  if (!bundle || !Array.isArray(bundle.results)) return "";
  // Very compact, high-signal context for the model
  return bundle.results.slice(0, 6).map((r, i) => {
    const title = r.title || "";
    const source = r.source || (r.url ? new URL(r.url).hostname : "");
    const when = r.published ? ` • ${r.published}` : "";
    const snip = r.snippet ? ` — ${r.snippet}` : "";
    return `${i + 1}. ${title} (${source}${when})${snip}`;
  }).join("\n");
}

function compactSourceList(bundle) {
  if (!bundle || !Array.isArray(bundle.results)) return "";
  const names = [];
  for (const r of bundle.results.slice(0, 5)) {
    const s = r.source || (r.url ? new URL(r.url).hostname : "");
    if (s && !names.includes(s)) names.push(s);
  }
  return names.join(", ");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const user_id = String(body.user_id || "anon");
    const message = String(body.message || "").trim();
    if (!message) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing `message`" }),
      };
    }

    const base = getBase(event);
    const needsSearch = shouldSearch(message);
    let searchBundle = null;

    if (needsSearch) {
      try {
        const q = message.replace(/^search:/i, "").trim();
        const resp = await fetch(`${base}/.netlify/functions/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, fresh: true, max: 8 }),
        });
        if (resp.ok) searchBundle = await resp.json();
        else console.error("search() non-200:", resp.status, await resp.text().catch(() => ""));
      } catch (e) {
        console.error("search() error:", e);
      }
    }

    // ===== Prompt guardrails =====
    const styleRules = [
      "Speak like a helpful, grounded friend. Match the user's tone; avoid over-slang.",
      "Do NOT read headlines or URLs back line-by-line. Summarize with specifics.",
      "Only say a brief buffer like “just a sec” when the explanation is long AND complex.",
      "Prefer names, numbers, dates, and concrete examples (e.g., named skins, weapons, bosses).",
      "If the sources disagree or are unclear, state what’s uncertain and ask one tight follow-up.",
      "Keep it tight. 80–140 words is ideal unless detail is demanded.",
      "End with compact sources, e.g., (Fortnite News, GameSpot).",
    ].join(" ");

    const answerFormat = [
      "FORMAT STRICTLY:",
      "• First line: **Quick take:** one punchy sentence with your POV.",
      "• Next up to 3 bullets: crisp specifics that matter (names, changes, dates).",
      "• One single follow-up question.",
      "• Final line: (Sources: A, B, C)",
    ].join(" ");

    const messages = [
      { role: "system", content: `You are Keilani. ${styleRules} ${answerFormat}` },
      { role: "user", content: `User (${user_id}) asked: ${message}` },
    ];

    if (searchBundle?.results?.length) {
      messages.push({
        role: "system",
        content:
          "Use these fresh results as your evidence. Ground your bullets in them without repeating titles verbatim:\n" +
          briefResults(searchBundle),
      });
    }

    // OpenAI call
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const temperature = Number(process.env.OPENAI_TEMPERATURE || 0.6);
    const maxTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 500);

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });

    if (!aiResp.ok) {
      const errTxt = await aiResp.text().catch(() => "");
      throw new Error(`OpenAI error ${aiResp.status}: ${errTxt}`);
    }

    let reply = (await aiResp.json())?.choices?.[0]?.message?.content?.trim() || "";
    const srcList = compactSourceList(searchBundle);
    if (searchBundle?.results?.length && srcList && !reply.includes("(Sources:")) {
      reply += `\n(Sources: ${srcList})`;
    }

    const citations =
      searchBundle?.results?.slice(0, 6).map((r) => ({
        title: r.title,
        url: r.url,
        source: r.source || null,
        published: r.published || null,
      })) || [];

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reply, meta: { searched: !!searchBundle, citations } }),
    };
  } catch (err) {
    console.error("chat handler error:", err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(err.message || err) }),
    };
  }
};
