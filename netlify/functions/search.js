// netlify/functions/search.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Use POST" };
    }
    const { q, max_results = 5 } = JSON.parse(event.body || "{}");
    if (!q) return { statusCode: 400, body: JSON.stringify({ error: "missing q" }) };

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "missing_tavily_key" }) };

    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        query: q,
        topic: "news",
        max_results,
        include_raw_content: false,
        include_answer: true
      })
    });

    if (!r.ok) {
      const text = await r.text().catch(()=> "");
      return { statusCode: 502, body: JSON.stringify({ error:"tavily_error", detail: text }) };
    }

    const data = await r.json();
    const results = (data.results || []).map(x => ({
      title: x.title, url: x.url, snippet: x.content || x.snippet || ""
    }));
    return {
      statusCode: 200,
      body: JSON.stringify({ answer: data.answer || "", results })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "server_error", detail: String(e?.message || e) }) };
  }
};
