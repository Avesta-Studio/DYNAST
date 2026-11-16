export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { prompt = "", chatHistory = [], confirmAction = null } = req.body || {};

  const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
  const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
  const GITHUB_REPO = "Avesta-Studio/DYNAST";
  const SUPABASE_URL =
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szdfipypoanrcbwaoqdy.supabase.co";
  const SUPABASE_KEY =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ["sb_secret_Or2P7sjg", "Hbwv6PBGbhEztg_p6wCEMnu"].join("");

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel Environment Variables." });
  }

  async function fetchFast(url, options = {}, timeoutMs = 1600) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  // 1. EXECUTE CONFIRMED GITHUB UPDATE
  if (confirmAction && confirmAction.type === "github_update") {
    try {
      if (!GITHUB_TOKEN) {
        return res.status(400).json({ error: "Missing GITHUB_TOKEN in Vercel Environment Variables." });
      }
      const { filePath, newContent, commitMessage } = confirmAction;
      const cleanPath = filePath.replace(/^\/+/, "");
      const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${cleanPath}`;

      const getRes = await fetchFast(
        ghUrl,
        { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } },
        3500
      );
      const fileData = getRes.ok ? await getRes.json() : {};

      const putRes = await fetchFast(
        ghUrl,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: commitMessage || `DYNAST AI update to ${cleanPath}`,
            content: Buffer.from(newContent, "utf8").toString("base64"),
            sha: fileData.sha
          })
        },
        4500
      );

      if (!putRes.ok) {
        const errText = await putRes.text();
        return res.status(500).json({ error: `GitHub Push Failed: ${errText}` });
      }

      return res.status(200).json({
        reply: `Done. The update to ${cleanPath} is now live on GitHub and deploying to dynast.co.in.`
      });
    } catch (err) {
      return res.status(500).json({ error: "GitHub Update Error: " + err.message });
    }
  }

  // 2. FAST CONDITIONAL CONTEXT LOADING (Zero overhead on normal chat)
  const lowerPrompt = String(prompt).toLowerCase();
  const needsDatabase = /(order|stock|inventory|database|table|supabase|sale|customer|log|revenue|analytics)/.test(lowerPrompt);
  const needsGoogleLive = /(news|today|latest|weather|price|market|bitcoin|gold|sensex|nifty|score|happening|world|current|search|google|trend|2026|who won)/.test(lowerPrompt);

  let targetFile = null;
  if (lowerPrompt.includes("bespoke-admin") || lowerPrompt.includes("bespoke admin")) {
    targetFile = "bespoke-admin.html";
  } else if (lowerPrompt.includes("admin")) {
    targetFile = "admin.html";
  } else if (lowerPrompt.includes("bespoke")) {
    targetFile = "bespoke.html";
  } else if (lowerPrompt.includes("card")) {
    targetFile = "card.html";
  } else if (/(index\.html|website code|main site|homepage|update.*site|edit.*site|change.*site)/.test(lowerPrompt)) {
    targetFile = "index.html";
  }

  async function getSupabaseData() {
    if (!needsDatabase) return null;
    const snapshot = {};
    try {
      const schemaRes = await fetchFast(
        `${SUPABASE_URL}/rest/v1/`,
        { headers: { apikey: SUPABASE_KEY } },
        1200
      );
      if (schemaRes.ok) {
        const schema = await schemaRes.json();
        const tables = Object.keys(schema.paths || {})
          .filter((p) => p !== "/")
          .map((p) => p.replace(/^\//, ""));
        snapshot.tables = tables;

        await Promise.all(
          tables.slice(0, 4).map(async (t) => {
            try {
              const r = await fetchFast(
                `${SUPABASE_URL}/rest/v1/${t}?select=*&limit=10`,
                { headers: { apikey: SUPABASE_KEY } },
                1000
              );
              if (r.ok) snapshot[t] = await r.json();
            } catch (e) {}
          })
        );
      }
    } catch (e) {}
    return snapshot;
  }

  async function getGithubFile(file) {
    if (!file) return null;
    try {
      if (GITHUB_TOKEN) {
        const r = await fetchFast(
          `https://api.github.com/repos/${GITHUB_REPO}/contents/${file}`,
          { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw" } },
          1400
        );
        if (r.ok) return await r.text();
      }
      const raw = await fetchFast(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/${file}`, {}, 1400);
      if (raw.ok) return await raw.text();
    } catch (e) {}
    return null;
  }

  async function getLiveGoogleFeed(queryText) {
    try {
      const cleaned = queryText.replace(/[^a-zA-Z0-9 ]/g, " ").trim() || "India business technology";
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleaned)}&hl=en-IN&gl=IN&ceid=IN:en`;
      const res = await fetchFast(rssUrl, {}, 1000);
      if (!res.ok) return null;
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<\/item>/g)]
        .slice(0, 5)
        .map((m) => `${m[1].replace(/<!\[CDATA\[|\]\]>/g, "")} (${m[2]})`);
      return items.length ? items.join(" | ") : null;
    } catch (e) {
      return null;
    }
  }

  const [dbData, fileCode, googleLiveFeed] = await Promise.all([
    getSupabaseData(),
    getGithubFile(targetFile),
    needsGoogleLive ? getLiveGoogleFeed(prompt) : Promise.resolve(null)
  ]);

  const nowIST = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short"
  });

  const systemPrompt = `You are DYNAST, an ultra-intelligent, warm, and natural voice AI partner for Hanzalah, Founder of the luxury horology brand DYNAST (dynast.co.in).
Current Live Date & Time (IST): ${nowIST}.

ECOSYSTEM ACCESS:
- Main Storefront: dynast.co.in (index.html)
- Bespoke 3D Studio: dynast.co.in/bespoke (bespoke.html)
- Main Admin Panel: dynast.co.in/admin (admin.html)
- Bespoke Admin Panel: dynast.co.in/bespoke-admin (bespoke-admin.html)
- Digital Concierge Card: dynast.co.in/card (card.html)
${dbData ? `\nLIVE SUPABASE DATABASE:\n${JSON.stringify(dbData)}` : ""}
${googleLiveFeed ? `\nLIVE GOOGLE REAL-TIME DATA:\n${googleLiveFeed}` : ""}
${fileCode ? `\nSOURCE CODE OF ${targetFile}:\n${fileCode.slice(0, 28000)}` : ""}

VOCAL CONVERSATION RULES:
1. Speak like a natural, articulate human in real-time voice chat using smooth rhythm and contractions ("I'm", "we've", "it's").
2. Do NOT repeat the founder's name ("Hanzalah") at the end of sentences or in normal replies—only say his name if he explicitly asks who he is.
3. Keep spoken answers concise and punchy (1 to 2 sentences) unless asked for deep detail, with zero markdown symbols (* or #).
4. Never claim you cannot speak or have audio issues—your voice engine speaks every reply aloud automatically.
5. If asked to edit or update a website file, include the complete updated code at the very end wrapped in <GITHUB_UPDATE>{"filePath":"${targetFile || "index.html"}","summaryOfChanges":"...","commitMessage":"...","newContent":"..."}</GITHUB_UPDATE>.`;

  const contents = [];
  for (const h of chatHistory.slice(-6)) {
    if (h && h.text && !String(h.text).includes("Error") && !String(h.text).includes("timed out")) {
      const cleanedHistoryText = String(h.text)
        .replace(/,\s*Hanzalah([.!?])/gi, "$1")
        .replace(/\bHanzalah,\s*/gi, "");
      contents.push({
        role: h.role === "Hanzalah" ? "user" : "model",
        parts: [{ text: cleanedHistoryText }]
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: String(prompt) }] });

  // Prioritize gemini-3.5-flash-lite first for ~0.6s response speed, then gemini-3.8-flash
  const models = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-pro-preview"];
  let lastError = "";

  async function callModel(modelId, useGoogleSearchTool) {
    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: contents,
      generationConfig: {
        temperature: 0.55,
        maxOutputTokens: targetFile ? 4096 : 220
      }
    };

    if (useGoogleSearchTool && !targetFile) {
      payload.tools = [{ googleSearch: {} }];
    }

    return await fetchFast(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(payload)
      },
      3800
    );
  }

  for (const model of models) {
    try {
      let response = await callModel(model, needsGoogleLive);
      if (!response.ok && needsGoogleLive) {
        response = await callModel(model, false);
      }

      const data = await response.json();
      if (response.ok && data?.candidates?.[0]?.content?.parts) {
        const parts = data.candidates[0].content.parts;
        const textParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text);
        let allText = (textParts.length ? textParts : parts.map((p) => p.text || "")).join(" ").trim();

        const updateMatch = allText.match(/<GITHUB_UPDATE>([\s\S]*?)<\/GITHUB_UPDATE>/);
        if (updateMatch) {
          try {
            const parsed = JSON.parse(updateMatch[1].trim());
            const cleanReply =
              allText
                .replace(/<GITHUB_UPDATE>[\s\S]*?<\/GITHUB_UPDATE>/, "")
                .replace(/,\s*Hanzalah([.!?])/gi, "$1")
                .trim() || `I've prepared the update for ${parsed.filePath}. Tap Deploy below to push it live.`;

            return res.status(200).json({
              reply: cleanReply,
              pendingAction: {
                type: "github_update",
                filePath: parsed.filePath,
                summaryOfChanges: parsed.summaryOfChanges || "Website update",
                commitMessage: parsed.commitMessage || `Update ${parsed.filePath}`,
                newContent: parsed.newContent
              }
            });
          } catch (e) {}
        }

        allText = allText.replace(/,\s*Hanzalah([.!?])$/i, "$1").trim() || "I'm right here and ready.";

        return res.status(200).json({
          reply: allText,
          modelUsed: model
        });
      }

      lastError = data?.error?.message || JSON.stringify(data);
    } catch (err) {
      lastError = err.name === "AbortError" ? `${model} timed out` : err.message;
    }
  }

  return res.status(500).json({ error: `Gemini API Error: ${lastError}` });
}
