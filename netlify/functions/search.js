// netlify/functions/search.js
// Purpose: Hit Serper.dev, then have OpenAI extract SPECIFICS (characters/skins, weapons, POIs, modes)
// and return a structured + concise summary with source links.

const fetch = require("node-fetch");
const OpenAI = require("openai");

const SERPER_URL = "https://google.serper.dev/search";
const SERPER_NEWS_URL = "https://google.serper.dev/news";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = JSON.parse(event.body || "{}");
    const qRaw = String(body.q || "").trim();
    if (!qRaw) {
      return { statusCode: 400, body: JSON.stringify({ error: "missing_q" }) };
    }

    const serperKey = envOrThrow("SERPER_API_KEY");

    // Bias toward official / reliable sources for Fortnite specifics
    const q =
      `${qRaw} site:fortnite.com OR site:epicgames.com OR site:ign.com OR site:gamespot.com OR site:polygon.com OR site:eurogamer.net`;

    // 1) Web search
    const serperRes = await fetch(SERPER_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": serperKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q }),
    });

    if (!serperRes.ok) {
      const text = await serperRes.text().catch(() => "");
      return {
        statusCode: serperRes.status,
        body: JSON.stringify({ error: "serper_error", detail: text }),
      };
    }

    const serperJson = await serperRes.json();

    // 2) News (sometimes patch notes are in news first)
    const newsRes = await fetch(SERPER_NEWS_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": serperKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: qRaw }),
    }).catch(() => null);

    let newsJson = null;
    if (newsRes && newsRes.ok) {
      newsJson = await newsRes.json().catch(() => null);
    }

    // Collect candidate items
    const items = [];
    const pushItem = (t, s, l, d) => {
      if (!t || !l) return;
      items.push({
        title: String(t).slice(0, 280),
        snippet: s ? String(s).slice(0, 600) : "",
        url: l,
        source: new URL(l).hostname.replace(/^www\./, ""),
        published: d || null,
      });
    };

    (serperJson.organic || []).slice(0, 8).forEach(r =>
      pushItem(r.title, r.snippet, r.link, r.date || null)
    );
    (newsJson?.news || []).slice(0, 6).forEach(n =>
      pushItem(n.title, n.snippet, n.link, n.date || null)
    );

    if (!items.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          answer:
            "I couldn’t find reliable details right now. Try rephrasing, or name a specific feature (characters, weapons, POIs).",
          results: [],
        }),
      };
    }

    // 3) Ask OpenAI to extract SPECIFICS (low temperature, force structure)
    const sys =
      "You extract concrete patch specifics from short web snippets.\n" +
      "If Fortnite is mentioned, list: new characters/skins/collabs, new or vaulted weapons, map POIs/biomes, game modes/LTMs, key balance changes, and date/version.\n" +
      "Prefer official sources; cite 2–4 top sources (hostnames) with URLs.\n" +
      "Return JSON ONLY with keys: version, date, characters, weapons, map, modes, balance, highlights, sources[].\n" +
      "Each of characters/weapons/map/modes/balance should be an array of short, concrete bullets.\n" +
      "If unknown, use empty array.";

    const user = [
      { role: "user", content: `Query: ${qRaw}` },
      {
        role: "user",
        content:
          "Snippets:\n" +
          items
            .map(
              (i, n) =>
                `${n + 1}. [${i.source}] ${i.title}\n   ${i.snippet}\n   ${i.url}`
            )
            .join("\n\n"),
      },
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        { role: "system", content: sys },
        ...user,
      ],
      response_format: { type: "json_object" },
    });

    let structured;
    try {
      structured = JSON.parse(ai.choices?.[0]?.message?.content || "{}");
    } catch {
      structured = {};
    }

    const sources = Array.isArray(structured.sources) ? structured.sources : [];
    const mkUrlMap = new Map(items.map(i => [i.url, i]));
    // If the model returned hostnames only, try to map them back to one of the found URLs.
    const cited = sources
      .map(s => {
        // s might be an object {name, url} or string hostname
        if (s?.url) return s;
        const host = String(s?.name || s).replace(/^www\./, "");
        const found = items.find(it => it.source.replace(/^www\./, "") === host);
        return found ? { name: found.source, url: found.url } : null;
      })
      .filter(Boolean)
      .slice(0, 4);

    // Build a tight answer for the chat function to speak
    const bullets = (label, arr) =>
      arr && arr.length
        ? `**${label}:**\n- ` + arr.slice(0, 6).join("\n- ") + "\n\n"
        : "";

    const answer =
      `Here’s what turned up ${structured.version ? `(v${structured.version})` : ""}${structured.date ? ` — ${structured.date}` : ""}:\n\n` +
      bullets("Characters/Collabs", structured.characters) +
      bullets("Weapons", structured.weapons) +
      bullets("Map/POIs", structured.map) +
      bullets("Modes/LTMs", structured.modes) +
      bullets("Balance", structured.balance) +
      (structured.highlights?.length
        ? "**Standout:** " + structured.highlights[0]
        : "") +
      (cited.length
        ? "\n\nSources: " +
          cited.map(s => `[${s.name}](${s.url})`).join(", ")
        : "");

    return {
      statusCode: 200,
      body: JSON.stringify({
        answer,
        results: items.slice(0, 8),
        structured,
        searched: true,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "server_error", detail: String(err?.message || err) }),
    };
  }
};
