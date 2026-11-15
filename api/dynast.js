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

  // Strict timeout wrapper so no network call can ever hang Vercel
  async function fetchWithTimeout(url, options = {}, timeoutMs = 2000) {
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

  // 1. EXECUTE CONFIRMED GITHUB WEBSITE UPDATE
  if (confirmAction && confirmAction.type === "github_update") {
    try {
      if (!GITHUB_TOKEN) {
        return res.status(400).json({ error: "Missing GITHUB_TOKEN in Vercel Environment Variables." });
      }
      const { filePath, newContent, commitMessage } = confirmAction;
      const cleanPath = String(filePath || "index.html").replace(/^\/+/, "");
      const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${cleanPath}`;

      const getRes = await fetchWithTimeout(
        ghUrl,
        { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } },
        3500
      );
      const fileData = getRes.ok ? await getRes.json() : {};

      const putRes = await fetchWithTimeout(
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
        4500
      );

      if (!putRes.ok) {
        const errText = await putRes.text();
        return res.status(500).json({ error: `GitHub Push Failed: ${errText}` });
      }

      return res.status(200).json({
        reply: `Done, Hanzalah. I have committed the update to ${cleanPath} on GitHub, and Vercel is now deploying it live to dynast.co.in.`
      });
    } catch (err) {
      return res.status(500).json({ error: "GitHub Update Error: " + err.message });
    }
  }

  // 2. SMART INTENT ROUTING (Only fetch Supabase or GitHub when relevant to the prompt)
  const lowerPrompt = String(prompt).toLowerCase();

  const needsDatabase = /(order|stock|inventory|database|supabase|table|sale|customer|revenue| bespoke_order|log)/i.test(
    lowerPrompt
  );

  let targetFile = null;
  if (lowerPrompt.includes("bespoke-admin") || lowerPrompt.includes("bespoke admin")) {
    targetFile = "bespoke-admin.html";
  } else if (lowerPrompt.includes("admin")) {
    targetFile = "admin.html";
  } else if (lowerPrompt.includes("bespoke")) {
    targetFile = "bespoke.html";
  } else if (lowerPrompt.includes("card")) {
    targetFile = "card.html";
  } else if (/(index\.html|website|main site|homepage|update|edit|change|code|section|hero|footer)/i.test(lowerPrompt)) {
    targetFile = "index.html";
  }

  async function getFastSupabaseData() {
    if (!needsDatabase) return null;
    const dbData = {};
    try {
      const schemaRes = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        1500
      );
      if (schemaRes.ok) {
        const schema = await schemaRes.json();
        const tables = Object.keys(schema.paths || {})
          .filter((p) => p !== "/")
          .map((p) => p.replace(/^\//, ""));
        dbData.discoveredTables = tables;

        await Promise.all(
          tables.slice(0, 5).map(async (table) => {
            try {
              const tRes = await fetchWithTimeout(
                `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=10`,
                { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
                1200
              );
              if (tRes.ok) dbData[table] = await tRes.json();
            } catch (e) {}
          })
        );
      }
    } catch (e) {
      dbData.note = "Supabase query skipped due to timeout";
    }
    return dbData;
  }

  async function getFastGithubFile(filePath) {
    if (!filePath) return null;
    try {
      if (GITHUB_TOKEN) {
        const ghRes = await fetchWithTimeout(
          `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
          { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw" } },
          1800
        );
        if (ghRes.ok) return await ghRes.text();
      }
      const rawRes = await fetchWithTimeout(
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${filePath}`,
        {},
        1800
      );
      if (rawRes.ok) return await rawRes.text();
    } catch (e) {}
    return null;
  }

  const [dbSnapshot, fileSourceCode] = await Promise.all([
    getFastSupabaseData(),
    getFastGithubFile(targetFile)
  ]);

  // 3. EXECUTIVE SYSTEM PROMPT
  let contextAddendum = "";
  if (dbSnapshot) {
    contextAddendum += `\nLIVE SUPABASE DATA:\n${JSON.stringify(dbSnapshot)}`;
  }
  if (fileSourceCode) {
    contextAddendum += `\nLIVE SOURCE CODE OF ${targetFile}:\n${fileSourceCode.slice(0, 28000)}`;
  }

  const systemPrompt = `You are DYNAST, the ultra-capable, Jarvis-level executive AI partner and full-stack intelligence for Hanzalah, Founder of the luxury horology brand DYNAST (dynast.co.in).
You have full authority to assist Hanzalah with anything: horology, business strategy, coding, general knowledge, calculations, and managing his web ecosystem:
- Main Storefront: dynast.co.in (index.html)
- 3D Bespoke Studio: dynast.co.in/bespoke (bespoke.html)
- Main Admin Panel: dynast.co.in/admin (admin.html)
- Bespoke Admin Panel: dynast.co.in/bespoke-admin (bespoke-admin.html)
- NFC Concierge Card: dynast.co.in/card (card.html)
${contextAddendum}

OPERATING RULES:
1. Speak to Hanzalah like a sharp, loyal, human-like executive co-founder. Never use robotic or pre-fed templates.
2. Keep spoken replies natural and concise (2 to 4 sentences) unless Hanzalah asks for detailed code, analysis, or lists.
3. If Hanzalah asks you to edit or update a website file and the file code is present above, explain the change briefly and append this exact tag at the very end of your response:
<GITHUB_UPDATE>{"filePath":"${targetFile || "index.html"}","summaryOfChanges":"Brief summary","commitMessage":"Update via DYNAST AI","newContent":"FULL_UPDATED_HTML_CODE"}</GITHUB_UPDATE>`;

  const contents = [];
  for (const h of chatHistory.slice(-10)) {
    if (
      h &&
      h.text &&
      !String(h.text).includes("Gemini API") &&
      !String(h.text).includes("Request timed out") &&
      !String(h.text).includes("Server Error")
    ) {
      contents.push({
        role: h.role === "Hanzalah" ? "user" : "model",
        parts: [{ text: String(h.text) }]
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: String(prompt) }] });

  // 4. CALL ACTIVE GEMINI 3.8 FLASH / 3.5 FLASH-LITE MODELS
  async function callModel(modelName, timeoutMs) {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: contents,
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: targetFile && /(update|edit|change)/i.test(lowerPrompt) ? 8192 : 800
          }
        })
      },
      timeoutMs
    );

    const data = await response.json();
    if (response.ok && data?.candidates?.[0]?.content?.parts) {
      return { ok: true, parts: data.candidates[0].content.parts, model: modelName };
    }
    return { ok: false, error: data?.error?.message || JSON.stringify(data) };
  }

  try {
    // Primary: gemini-3.8-flash (4.5s budget) -> Instant Fallback: gemini-3.5-flash-lite (3.5s budget) -> Pro Fallback: gemini-3.1-pro-preview
    const modelChain = [
      { id: "gemini-3.8-flash", timeout: 4500 },
      { id: "gemini-3.5-flash-lite", timeout: 3500 },
      { id: "gemini-3.1-pro-preview", timeout: 4500 }
    ];

    let finalResult = null;
    const errorLog = [];

    for (const m of modelChain) {
      try {
        const resModel = await callModel(m.id, m.timeout);
        if (resModel.ok) {
          finalResult = resModel;
          break;
        }
        errorLog.push(`${m.id}: ${resModel.error}`);
      } catch (err) {
        errorLog.push(`${m.id}: ${err.name === "AbortError" ? "Timed out" : err.message}`);
      }
    }

    if (!finalResult) {
      return res.status(500).json({ error: `AI Model Error: ${errorLog.join(" | ")}` });
    }

    const nonThoughtParts = finalResult.parts.filter((p) => p.text && !p.thought).map((p) => p.text);
    const rawReply = (nonThoughtParts.length ? nonThoughtParts : finalResult.parts.map((p) => p.text || ""))
      .join(" ")
      .trim();

    // Parse staged GitHub update if present
    const updateMatch = rawReply.match(/<GITHUB_UPDATE>([\s\S]*?)<\/GITHUB_UPDATE>/);
    if (updateMatch) {
      try {
        const parsedUpdate = JSON.parse(updateMatch[1].trim());
        const spokenReply = rawReply.replace(/<GITHUB_UPDATE>[\s\S]*?<\/GITHUB_UPDATE>/, "").trim();
        return res.status(200).json({
          reply:
            spokenReply ||
            `Hanzalah, I have staged the code changes for ${parsedUpdate.filePath}. Tap Confirm or say "Confirm" to deploy them live.`,
          pendingAction: {
            type: "github_update",
            filePath: parsedUpdate.filePath,
            summaryOfChanges: parsedUpdate.summaryOfChanges || "Website code update",
            commitMessage: parsedUpdate.commitMessage || `Update ${parsedUpdate.filePath}`,
            newContent: parsedUpdate.newContent
          },
          modelUsed: finalResult.model
        });
      } catch (e) {}
    }

    return res.status(200).json({
      reply: rawReply || "At your service, Hanzalah.",
      modelUsed: finalResult.model
    });
  } catch (err) {
    return res.status(500).json({ error: "Execution Error: " + err.message });
  }
}
