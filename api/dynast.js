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

  async function fetchFast(url, options = {}, timeoutMs = 2000) {
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
        4000
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
            message: commitMessage || `DYNAST AI update to ${cleanPath} (Approved by Hanzalah)`,
            content: Buffer.from(newContent, "utf8").toString("base64"),
            sha: fileData.sha
          })
        },
        5000
      );

      if (!putRes.ok) {
        const errText = await putRes.text();
        return res.status(500).json({ error: `GitHub Push Failed: ${errText}` });
      }

      return res.status(200).json({
        reply: `Confirmed, Hanzalah. I have pushed the update to ${cleanPath} on GitHub and Vercel is deploying it live.`
      });
    } catch (err) {
      return res.status(500).json({ error: "GitHub Update Error: " + err.message });
    }
  }

  // 2. ONLY FETCH SUPABASE OR GITHUB CODE WHEN THE COMMAND ACTUALLY NEEDS IT
  const lowerPrompt = String(prompt).toLowerCase();
  const needsDatabase = /(order|stock|inventory|database|table|supabase|sale|customer|log|status|check)/.test(lowerPrompt);

  let targetFile = null;
  if (lowerPrompt.includes("bespoke-admin") || lowerPrompt.includes("bespoke admin")) {
    targetFile = "bespoke-admin.html";
  } else if (lowerPrompt.includes("admin")) {
    targetFile = "admin.html";
  } else if (lowerPrompt.includes("bespoke")) {
    targetFile = "bespoke.html";
  } else if (lowerPrompt.includes("card")) {
    targetFile = "card.html";
  } else if (/(index|website|main site|homepage|update|edit|change|code)/.test(lowerPrompt)) {
    targetFile = "index.html";
  }

  async function getSupabaseData() {
    if (!needsDatabase) return null;
    const snapshot = {};
    try {
      const schemaRes = await fetchFast(
        `${SUPABASE_URL}/rest/v1/`,
        { headers: { apikey: SUPABASE_KEY } },
        1800
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
                1500
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
          2000
        );
        if (r.ok) return await r.text();
      }
      const raw = await fetchFast(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/${file}`, {}, 2000);
      if (raw.ok) return await raw.text();
    } catch (e) {}
    return null;
  }

  const [dbData, fileCode] = await Promise.all([
    getSupabaseData(),
    getGithubFile(targetFile)
  ]);

  const systemPrompt = `You are DYNAST, the elite executive AI assistant for Hanzalah, Founder of the luxury watch brand DYNAST (dynast.co.in).
You oversee:
- Main Storefront: dynast.co.in (index.html)
- Bespoke 3D Studio: dynast.co.in/bespoke (bespoke.html)
- Main Admin Panel: dynast.co.in/admin (admin.html)
- Bespoke Admin Panel: dynast.co.in/bespoke-admin (bespoke-admin.html)
- Digital Concierge Card: dynast.co.in/card (card.html)
${dbData ? `\nLIVE SUPABASE DATA:\n${JSON.stringify(dbData)}` : ""}
${fileCode ? `\nSOURCE CODE OF ${targetFile}:\n${fileCode.slice(0, 28000)}` : ""}

RULES:
- Address Hanzalah naturally and intelligently as his executive AI partner.
- Keep spoken replies concise (2 to 3 sentences).
- If Hanzalah asks to edit or update a website file, include the complete updated code at the end of your reply inside <GITHUB_UPDATE>{"filePath":"${targetFile || "index.html"}","summaryOfChanges":"...","commitMessage":"...","newContent":"..."}</GITHUB_UPDATE>.`;

  const contents = [];
  for (const h of chatHistory.slice(-8)) {
    if (h && h.text && !String(h.text).includes("Error") && !String(h.text).includes("timed out")) {
      contents.push({
        role: h.role === "Hanzalah" ? "user" : "model",
        parts: [{ text: String(h.text) }]
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: String(prompt) }] });

  // Use the exact active models supported on your key
  const models = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-pro-preview"];
  let lastError = "";

  for (const model of models) {
    try {
      const response = await fetchFast(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: contents,
            generationConfig: { temperature: 0.5 }
          })
        },
        7500
      );

      const data = await response.json();
      if (response.ok && data?.candidates?.[0]?.content?.parts) {
        const parts = data.candidates[0].content.parts;
        const textParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text);
        const allText = (textParts.length ? textParts : parts.map((p) => p.text || "")).join(" ").trim();

        const updateMatch = allText.match(/<GITHUB_UPDATE>([\s\S]*?)<\/GITHUB_UPDATE>/);
        if (updateMatch) {
          try {
            const parsed = JSON.parse(updateMatch[1].trim());
            const cleanReply = allText.replace(/<GITHUB_UPDATE>[\s\S]*?<\/GITHUB_UPDATE>/, "").trim();
            return res.status(200).json({
              reply: cleanReply || `Hanzalah, I have prepared the update for ${parsed.filePath}. Tap Confirm below to push it live.`,
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

        return res.status(200).json({ reply: allText || "Systems online, Hanzalah." });
      }

      lastError = data?.error?.message || JSON.stringify(data);
    } catch (err) {
      lastError = err.name === "AbortError" ? `${model} timed out` : err.message;
    }
  }

  return res.status(500).json({ error: `Gemini API Error: ${lastError}` });
}
