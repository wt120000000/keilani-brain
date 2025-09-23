// netlify/functions/chat.js
// CommonJS + SDK-free. Uses global fetch (Node 18+ / Netlify runtime).

/** CORS helper */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  };
}

/** Decide if a user message needs a fresh web search */
function shouldSearch(text) {
  if (!text) return false;
  const s = text.toLowerCase().trim();
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

/** Build absolute origin for internal calls */
function getBase(event, context) {
  // Order of preference: Netlify-provided URL envs → event headers → fallback
  return (
    process.env.URL ||
    process.env.SITE_URL ||
    (event && event.headers && (event.headers["x-forwarded-host"] ? `https://${event.headers["x-forwarded-host"]}` : null)) ||
    "https://api.keilani.ai"
  );
}

/** Shape search bundle into a compact, LLM-friendly string */
function summarizeResults(bundle) {
  if (!bundle || !Array.isArray(bundle.results)) return "";
  return bundle.results
    .slice(0, 5)
    .map((r, i) => {
      const src = r.source || r.url || "";
      const snip = r.snippet ? ` — ${r.snippet}` : "";
      return `${i + 1}. ${r.title}${snip} (${src})`;
    })
    .join("\n");
}

exports.handler = async (event, context) => {
  // Preflight
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
    const user_id = String(body.user_id || "anon"); // use it so ESLint chills
    const message = String(body.message || "").trim();

    if (!message) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing `message`" }),
      };
    }

    const base = getBase(event, context);
    const needsSearch = shouldSearch(message);

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
        } else {
          const errTxt = await resp.text().catch(() => "");
          console.error("search() non-200:", resp.status, errTxt);
        }
      } catch (e) {
        console.error("search() error:", e);
      }
    }

    // ——— Prompting ———
    const systemPrompt = [
      "You are Keilani, a helpful, grounded, down-to-earth assistant.",
      "Keep responses **specific and concise**. Match the user's tone without overdoing slang.",
      "If search results are provided, **use concrete details** (e.g., named skins, weapons, bosses, modes).",
      "Cite sources briefly in parentheses like (Fortnite News) or (GameSpot).",
      "Avoid generic filler. Only add a quick, natural buffer phrase if the user asked for something complex AND the explanation is long.",
      "If info is unclear in sources, say what’s uncertain and ask a short follow-up question.",
    ].join(" ");

    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `User (${user_id}) says: ${message}`,
      },
    ];

    if (searchBundle && Array.isArray(searchBundle.results) && searchBundle.results.length) {
      messages.push({
        role: "system",
        content:
          "Use these recent search results. Pull **specific** items and reflect them directly in your answer:\n" +
          summarizeResults(searchBundle),
      });
    }

    // ——— Call OpenAI ———
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const temperature = Number(process.env.OPENAI_TEMPERATURE || 0.6);
    const maxTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 500);

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (!aiResp.ok) {
      const errTxt = await aiResp.text().catch(() => "");
      throw new Error(`OpenAI error ${aiResp.status}: ${errTxt}`);
    }

    const aiData = await aiResp.json();
    const reply = aiData?.choices?.[0]?.message?.content?.trim() || "Sorry—no reply came back.";

    // Build meta, including light citations if we searched
    const citations =
      searchBundle?.results?.slice(0, 5).map((r) => ({
        title: r.title,
        url: r.url,
        source: r.source || null,
        published: r.published || null,
      })) || [];

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        reply,
        meta: { searched: !!searchBundle, citations },
      }),
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
