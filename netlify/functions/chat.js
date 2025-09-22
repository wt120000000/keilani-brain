// netlify/functions/chat.js
const fetch = require("node-fetch");

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const { user_id = "anon", message } = JSON.parse(event.body || "{}");
    if (!message) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing `message`" }),
      };
    }

    // ---------------------------
    // Force absolute base URL
    // ---------------------------
    const base =
      process.env.URL ||
      process.env.SITE_URL ||
      (context && context.site && context.site.url) ||
      "https://api.keilani.ai";

    // Decide if this message should trigger a search
    const lower = message.toLowerCase();
    const needsSearch =
      lower.includes("today") ||
      lower.includes("this week") ||
      lower.startsWith("search:") ||
      lower.includes("latest") ||
      lower.includes("new update") ||
      lower.includes("patch notes");

    let searchBundle = null;

    if (needsSearch) {
      try {
        const q = message.replace(/^search:/i, "").trim();
        const resp = await fetch(`${base}/.netlify/functions/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, fresh: true, max: 6 }),
        });
        if (resp.ok) {
          searchBundle = await resp.json();
        }
      } catch (err) {
        console.error("Search error", err);
      }
    }

    // ---------------------------
    // Build the prompt for the LLM
    // ---------------------------
    let systemPrompt = `
You are Keilani, a helpful, conversational AI.
Keep answers short but specific, grounded, and natural.
Match the user's tone and vibe.
If search results are provided, USE THEM: list notable skins, characters, weapons, collabs, or patch notes, and include parenthetical (source) tags.
Never make up vague info if specifics are present.
    `.trim();

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ];

    if (searchBundle && searchBundle.results && searchBundle.results.length > 0) {
      messages.push({
        role: "system",
        content: `Search results:\n${searchBundle.results
          .slice(0, 5)
          .map(
            (r, i) =>
              `${i + 1}. ${r.title} — ${r.snippet || ""} (${r.source || r.url})`
          )
          .join("\n")}\n\nUse these details in your reply.`,
      });
    }

    // ---------------------------
    // Call OpenAI
    // ---------------------------
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages,
        temperature: Number(process.env.OPENAI_TEMPERATURE || 0.7),
        max_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 400),
      }),
    });

    if (!openaiResp.ok) {
      const txt = await openaiResp.text();
      throw new Error(`OpenAI error: ${txt}`);
    }

    const data = await openaiResp.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "(no reply)";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        reply,
        meta: {
          searched: !!searchBundle,
          citations: searchBundle?.results?.map((r) => ({
            title: r.title,
            url: r.url,
            source: r.source,
          })),
        },
      }),
    };
  } catch (err) {
    console.error("Chat error", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
