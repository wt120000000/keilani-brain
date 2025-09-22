// netlify/functions/search.js
// CommonJS Netlify v1 handler calling Serper. Returns structured results + short synthesis.

function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
const ok = (o) => json(200, o);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    const { q = "", max = 6 } = JSON.parse(event.body || "{}");
    if (!q) return ok({ error: "missing_query" });

    const key = process.env.SERPER_API_KEY || "";
    if (!key) return ok({ searched: false, answer: `Search API key not configured. Query was: ${q}` });

    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "X-API-KEY": key },
      body: JSON.stringify({ q }),
    });

    if (!res.ok) {
      const body = await res.text();
      return ok({ searched: false, answer: "Could not search right now.", detail: body });
    }

    const data = await res.json();
    const organic = Array.isArray(data.organic) ? data.organic : [];
    const news = Array.isArray(data.news) ? data.news : [];

    // Normalize & pick
    const merged = [...organic, ...news].map((r) => ({
      title: r.title,
      url: r.link || r.url,
      source: r.source || (r.title && (r.title.split(" - ").slice(-1)[0] || "")) || "",
      published: r.date || r.datePublished || "",
      snippet: r.snippet || r.description || "",
    })).filter(r => r.title && r.url);

    const results = merged.slice(0, max);

    const answer = synthAnswer(q, results);
    return ok({ searched: true, answer, results });
  } catch (err) {
    return ok({ searched: false, error: "search_unhandled", detail: String(err) });
  }
};

function synthAnswer(q, results) {
  if (!results.length) return `Nothing solid yet for: ${q}`;
  const picks = results.slice(0, 3);
  const bullets = picks.map((r) => `• ${r.title}${r.source ? ` — ${r.source}` : ""}`).join("\n");
  return `Here’s what surfaced for “${q}”:\n${bullets}\nWant me to drill into one?`;
}
