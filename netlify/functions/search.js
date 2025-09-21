// netlify/functions/search.js
// Server-only: calls Serper, then fetches top result pages and asks OpenAI to
// extract SPECIFICS (characters/skins, weapons, POIs, modes, balance, version/date)
// Returns { answer, results[], structured, searched:true }

const SERPER_SEARCH = "https://google.serper.dev/search";
const SERPER_NEWS   = "https://google.serper.dev/news";
const OA_URL        = "https://api.openai.com/v1/chat/completions";

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// naive HTML -> text
function stripHtml(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { /* leave null */ }
  if (!res.ok) throw new Error(`${url} ${res.status}: ${txt}`);
  return data ?? {};
}

async function serper(type, q) {
  const key = need("SERPER_API_KEY");
  const url = type === "news" ? SERPER_NEWS : SERPER_SEARCH;
  return fetchJson(url, {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q,
      gl: "us",
      hl: "en",
      num: 10,
    }),
  });
}

async function fetchPages(urls = []) {
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome Safari NetlifyFunction";
  const out = [];
  for (const u of urls.slice(0, 4)) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": ua } });
      const html = await r.text();
      out.push({ url: u, text: stripHtml(html).slice(0, 6000) });
    } catch {
      // ignore individual failures
    }
  }
  return out;
}

async function openaiExtract(snippets, pages, originalQuery) {
  const apiKey = need("OPENAI_API_KEY");

  const system =
    "You extract concrete, current Fortnite patch specifics from snippets and page text. " +
    "Return JSON ONLY with keys: version, date, characters, weapons, map, modes, balance, " +
    "highlights, sources[]. Each of characters/weapons/map/modes/balance is an array of short bullets. " +
    "If unknown, use empty arrays. Prefer official fortnite.com/epicgames.com when conflicting.";

  const userContent =
    `Query: ${originalQuery}\n\n` +
    "Snippets:\n" +
    snippets
      .map(
        (s, i) =>
          `${i + 1}. [${s.source}] ${s.title}\n   ${s.snippet}\n   ${s.url}`
      )
      .join("\n\n") +
    "\n\nPage Text (truncated):\n" +
    pages
      .map((p, i) => `${i + 1}. ${p.url}\n${p.text}`)
      .join("\n\n");

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };

  const res = await fetch(OA_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const js = await res.json();
  if (!res.ok) throw new Error(`openai ${res.status}: ${JSON.stringify(js)}`);
  let content = {};
  try { content = JSON.parse(js.choices?.[0]?.message?.content || "{}"); } catch {}
  return content;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    const { q: rawQ } = JSON.parse(event.body || "{}");
    const qRaw = String(rawQ || "").trim();
    if (!qRaw) return { statusCode: 400, body: JSON.stringify({ error: "missing_q" }) };

    // Build a query strongly biased toward official + patch notes
    const q =
      `${qRaw} fortnite patch notes update version ` +
      "site:fortnite.com OR site:epicgames.com OR site:ign.com OR site:gamespot.com OR site:eurogamer.net";

    const web = await serper("search", q);
    const news = await serper("news", qRaw);

    const items = [];
    const push = (title, snippet, link, date) => {
      if (!title || !link) return;
      const host = "";
      items.push({
        title: String(title).slice(0, 300),
        snippet: String(snippet || "").slice(0, 600),
        url: link,
        source: new URL(link).hostname.replace(/^www\./, ""),
        date: date || null,
      });
    };

    (web.organic || []).forEach(r => push(r.title, r.snippet, r.link, r.date));
    (news.news || []).forEach(n => push(n.title, n.snippet, n.link, n.date));

    if (!items.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({ answer: "No fresh results found.", results: [], searched: true }),
      };
    }

    // Prefer likely patch pages
    const priority = (it) => {
      const t = it.title.toLowerCase();
      const s = it.source;
      let score = 0;
      if (/fortnite\.com|epicgames\.com/.test(s)) score += 5;
      if (/patch/.test(t)) score += 3;
      if (/\bv\d{2,}\b/.test(t) || /update/.test(t)) score += 2;
      return score;
    };
    const sorted = items
      .filter(i => i.url.startsWith("http"))
      .sort((a, b) => priority(b) - priority(a));

    const topForFetch = sorted.slice(0, 4).map(i => i.url);
    const pages = await fetchPages(topForFetch);

    const structured = await openaiExtract(sorted.slice(0, 8), pages, qRaw);

    const bullets = (label, arr) =>
      Array.isArray(arr) && arr.length
        ? `**${label}:**\n- ${arr.slice(0, 6).join("\n- ")}\n\n`
        : "";

    const answer =
      `Here’s what stood out ${structured.version ? `(v${structured.version})` : ""}${structured.date ? ` — ${structured.date}` : ""}:\n\n` +
      bullets("Characters/Collabs", structured.characters) +
      bullets("Weapons", structured.weapons) +
      bullets("Map/POIs", structured.map) +
      bullets("Modes/LTMs", structured.modes) +
      bullets("Balance", structured.balance) +
      (structured.highlights?.[0] ? `**Standout:** ${structured.highlights[0]}` : "") +
      (Array.isArray(structured.sources) && structured.sources.length
        ? "\n\nSources: " +
          structured.sources.slice(0, 4).map(s =>
            s?.url ? `[${s.name || new URL(s.url).hostname}](${s.url})`
                  : `${s.name || ""}`
          ).join(", ")
        : "");

    return {
      statusCode: 200,
      body: JSON.stringify({
        answer,
        results: sorted.slice(0, 8),
        structured,
        searched: true,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "search_error", detail: String(err?.message || err) }) };
  }
};
