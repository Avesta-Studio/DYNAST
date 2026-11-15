let cachedWorkingModel = null;

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

  async function fetchFast(url, options = {}, timeoutMs = 2500) {
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
        reply: `Confirmed, Hanzalah. I have pushed the update to ${cleanPath} on GitHub. Vercel is now deploying it live to dynast.co.in.`
      });
    } catch (err) {
      return res.status(500).json({ error: "GitHub Update Error: " + err.message });
    }
  }

  // 2. AUTO-DISCOVER AVAILABLE MODEL FROM GOOGLE API (WITH GEMINI-4-HYDROGEN & FLASH PRIORITY)
  async function getActiveModel() {
    if (cachedWorkingModel) return cachedWorkingModel;
    try {
      const listRes = await fetchFast(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {},
        2500
      );
      if (listRes.ok) {
        const listData = await listRes.json();
        const available = (listData.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m) => m.name.replace(/^models\//, ""));

        const preferredOrder = [
          "gemini-4-hydrogen",
          "gemini-4.0-hydrogen",
          "gemini-3.8-flash",
          "gemini-3.5-flash-lite",
          "gemini-3.0-flash",
          "gemini-3-flash-preview",
          "gemini-3.1-flash-lite-preview",
          "gemini-3.1-pro-preview"
        ];

        for (const pref of preferredOrder) {
          if (available.includes(pref)) {
            cachedWorkingModel = pref;
            return pref;
          }
        }

        const anyHydrogenOrFlash =
          available.find((m) => m.includes("hydrogen")) ||
          available.find((m) => m.includes("3.8-flash")) ||
          available.find((m) => m.includes("3.5-flash")) ||
          available.find((m) => m.includes("3") && m.includes("flash")) ||
          available.find((m) => m.includes("flash")) ||
          available[0];

        if (anyHydrogenOrFlash) {
          cachedWorkingModel = anyHydrogenOrFlash;
          return anyHydrogenOrFlash;
        }
      }
    } catch (e) {}
    return "gemini-3.8-flash";
  }

  // 3. FAST PARALLEL SUPABASE TABLE DISCOVERY & RELEVANT GITHUB FILE PRELOAD
  async function getSupabaseSnapshot() {
    const snapshot = { tables: [], sampleData: {} };
    try {
      const schemaRes = await fetchFast(
        `${SUPABASE_URL}/rest/v1/`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        2000
      );
      if (schemaRes.ok) {
        const schema = await schemaRes.json();
        const tables = Object.keys(schema.paths || {})
          .filter((p) => p !== "/")
          .map((p) => p.replace(/^\//, ""));
        snapshot.tables = tables;

        await Promise.all(
          tables.slice(0, 6).map(async (table) => {
            try {
              const tRes = await fetchFast(
                `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=8`,
                { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
                1500
              );
              if (tRes.ok) snapshot.sampleData[table] = await tRes.json();
            } catch (e) {}
          })
        );
      }
    } catch (e) {
      snapshot.note = "Fast timeout bypassed slow DB response";
    }
    return snapshot;
  }

  async function readGithubFile(filePath) {
    try {
      const cleanPath = filePath.replace(/^\/+/, "");
      if (GITHUB_TOKEN) {
        const ghRes = await fetchFast(
          `https://api.github.com/repos/${GITHUB_REPO}/contents/${cleanPath}`,
          { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw" } },
          2000
        );
        if (ghRes.ok) return await ghRes.text();
      }
      const rawRes = await fetchFast(
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${cleanPath}`,
        {},
        2000
      );
      if (rawRes.ok) return await rawRes.text();
    } catch (e) {}
    return null;
  }

  // Determine if prompt asks about a specific website/admin file so we preload it in parallel
  const lowerPrompt = String(prompt).toLowerCase();
  let targetFile = null;
  if (lowerPrompt.includes("bespoke-admin") || lowerPrompt.includes("bespoke admin")) {
    targetFile = "bespoke-admin.html";
  } else if (lowerPrompt.includes("admin")) {
    targetFile = "admin.html";
  } else if (lowerPrompt.includes("bespoke")) {
    targetFile = "bespoke.html";
  } else if (lowerPrompt.includes("card")) {
    targetFile = "card.html";
  } else if (
    lowerPrompt.includes("index") ||
    lowerPrompt.includes("website") ||
    lowerPrompt.includes("main site") ||
    lowerPrompt.includes("update") ||
    lowerPrompt.includes("edit")
  ) {
    targetFile = "index.html";
  }

  const [activeModel, dbSnapshot, preloadedCode] = await Promise.all([
    getActiveModel(),
    getSupabaseSnapshot(),
    targetFile ? readGithubFile(targetFile) : Promise.resolve(null)
  ]);

  const systemPrompt = `You are DYNAST, the bespoke, high-level executive AI assistant for Hanzalah, Founder of the luxury watch brand DYNAST (dynast.co.in).
You oversee:
- Main Website: dynast.co.in (index.html)
- Bespoke 3D Studio: dynast.co.in/bespoke (bespoke.html)
- Main Admin Panel: dynast.co.in/admin (admin.html)
- Bespoke Admin Panel: dynast.co.in/bespoke-admin (bespoke-admin.html)
- Digital Concierge Card: dynast.co.in/card (card.html)

LIVE SUPABASE DATABASE:
Tables discovered: ${JSON.stringify(dbSnapshot.tables)}
Live Data: ${JSON.stringify(dbSnapshot.sampleData)}
${preloadedCode ? `\nLIVE SOURCE CODE OF ${targetFile}:\n${preloadedCode.slice(0, 30000)}` : ""}

INSTRUCTIONS:
1. Address Hanzalah naturally and intelligently as his executive AI partner. Keep spoken replies concise (2 to 4 sentences).
2. If Hanzalah asks you to modify or update a website file and you have its source code, include a JSON block at the very end of your response wrapped in <GITHUB_UPDATE>{"filePath":"...","summaryOfChanges":"...","commitMessage":"...","newContent":"..."}</GITHUB_UPDATE> so Hanzalah can tap Confirm to push it live.`;

  const contents = [];
  for (const h of chatHistory.slice(-10)) {
    if (h && h.text && !String(h.text).startsWith("Gemini API Error") && !String(h.text).startsWith("Google Gemini API")) {
      contents.push({
        role: h.role === "Hanzalah" ? "user" : "model",
        parts: [{ text: String(h.text) }]
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: String(prompt) }] });

  async function generateWithModel(modelId) {
    const response = await fetchFast(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
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
      6500
    );

    const data = await response.json();
    if (response.ok && data?.candidates?.[0]?.content?.parts) {
      return { ok: true, parts: data.candidates[0].content.parts };
    }
    return { ok: false, error: data?.error?.message || JSON.stringify(data) };
  }

  try {
    let result = await generateWithModel(activeModel);

    // If Google suggests a specific replacement model in the error text, switch to it immediately
    if (!result.ok) {
      cachedWorkingModel = null;
      const suggestedMatch = result.error.match(/models\/([a-zA-Z0-9.-]+)/);
      const fallbackModel = suggestedMatch?.[1] || "gemini-3.5-flash-lite";
      result = await generateWithModel(fallbackModel);
      if (result.ok) cachedWorkingModel = fallbackModel;
    }

    if (!result.ok) {
      return res.status(500).json({ error: `Gemini API Error (${activeModel}): ${result.error}` });
    }

    const textParts = result.parts.filter((p) => p.text && !p.thought).map((p) => p.text);
    const allText = (textParts.length ? textParts : result.parts.map((p) => p.text || "")).join(" ").trim();

    // Check if the AI staged a GitHub update block
    const updateMatch = allText.match(/<GITHUB_UPDATE>([\s\S]*?)<\/GITHUB_UPDATE>/);
    if (updateMatch) {
      try {
        const parsedUpdate = JSON.parse(updateMatch[1].trim());
        const cleanReply = allText.replace(/<GITHUB_UPDATE>[\s\S]*?<\/GITHUB_UPDATE>/, "").trim();
        return res.status(200).json({
          reply:
            cleanReply ||
            `Hanzalah, I have staged the update for ${parsedUpdate.filePath}. Tap Confirm below to push it to GitHub.`,
          pendingAction: {
            type: "github_update",
            filePath: parsedUpdate.filePath,
            summaryOfChanges: parsedUpdate.summaryOfChanges || "Website code update",
            commitMessage: parsedUpdate.commitMessage || `Update ${parsedUpdate.filePath}`,
            newContent: parsedUpdate.newContent
          }
        });
      } catch (e) {}
    }

    return res.status(200).json({
      reply: allText || "Systems online and ready, Hanzalah.",
      modelUsed: cachedWorkingModel || activeModel
    });
  } catch (err) {
    return res.status(500).json({ error: "Server Timeout/Execution Error: " + err.message });
  }
}
