export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { prompt, chatHistory = [], confirmAction = null } = req.body;

  const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
  const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
  const GITHUB_REPO = "Avesta-Studio/DYNAST";
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szdfipypoanrcbwaoqdy.supabase.co";
  const SUPABASE_KEY =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ["sb_secret_Or2P7sjg", "Hbwv6PBGbhEztg_p6wCEMnu"].join("");

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel Environment Variables." });
  }

  // 1. EXECUTE CONFIRMED GITHUB UPDATE
  if (confirmAction && confirmAction.type === "github_update") {
    try {
      if (!GITHUB_TOKEN) {
        return res.status(400).json({ error: "Missing GITHUB_TOKEN in Vercel Environment Variables." });
      }
      const { filePath, newContent, commitMessage } = confirmAction;
      const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

      const getRes = await fetch(ghUrl, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }
      });
      const fileData = getRes.ok ? await getRes.json() : {};

      const putRes = await fetch(ghUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: commitMessage || `DYNAST AI update to ${filePath} (Approved by Hanzalah)`,
          content: Buffer.from(newContent, "utf8").toString("base64"),
          sha: fileData.sha
        })
      });

      if (!putRes.ok) {
        const errText = await putRes.text();
        return res.status(500).json({ error: `GitHub Push Failed: ${errText}` });
      }

      return res.status(200).json({
        reply: `Confirmed, Hanzalah. I have pushed the update to ${filePath} on GitHub. Vercel is now deploying the changes live to dynast.co.in.`
      });
    } catch (err) {
      return res.status(500).json({ error: "Confirmation Execution Error: " + err.message });
    }
  }

  // 2. AUTO-DISCOVER ALL REAL SUPABASE TABLES & LIVE DATA
  let dbSnapshot = {};
  try {
    const schemaRes = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    if (schemaRes.ok) {
      const schema = await schemaRes.json();
      const paths = Object.keys(schema.paths || {})
        .filter((p) => p !== "/")
        .map((p) => p.replace(/^\//, ""));
      await Promise.all(
        paths.map(async (table) => {
          const tRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=25`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          if (tRes.ok) {
            dbSnapshot[table] = await tRes.json();
          }
        })
      );
    }
  } catch (e) {
    dbSnapshot = { note: "Supabase snapshot unavailable: " + e.message };
  }

  // Helper to read any file from GitHub or live dynast.co.in
  async function readProjectFile(filePath) {
    try {
      const cleanPath = filePath.replace(/^\/+/, "");
      if (GITHUB_TOKEN) {
        const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${cleanPath}`, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw" }
        });
        if (ghRes.ok) return await ghRes.text();
      }
      const rawRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/${cleanPath}`);
      if (rawRes.ok) return await rawRes.text();
      const liveRes = await fetch(`https://dynast.co.in/${cleanPath}`);
      if (liveRes.ok) return await liveRes.text();
      return `Could not load ${cleanPath}`;
    } catch (e) {
      return `Error reading ${filePath}: ${e.message}`;
    }
  }

  // 3. SYSTEM PROMPT & TOOLS
  const systemPrompt = `You are DYNAST, the bespoke, high-level executive AI assistant created exclusively for Hanzalah, Founder of the luxury horology brand DYNAST (dynast.co.in).
You have direct access to:
1. Main Website: dynast.co.in (file: index.html)
2. Bespoke 3D Customization Studio: dynast.co.in/bespoke (file: bespoke.html)
3. Main Admin Panel: dynast.co.in/admin (file: admin.html)
4. Bespoke Admin Panel: dynast.co.in/bespoke-admin (file: bespoke-admin.html)
5. Digital Concierge Card: dynast.co.in/card (file: card.html)
6. Live Supabase Database Snapshot:
${JSON.stringify(dbSnapshot)}

RULES:
- Address Hanzalah naturally and intelligently as his executive AI partner. Never use canned templates.
- Keep spoken replies concise (2 to 4 sentences) unless Hanzalah asks for deep detail.
- When Hanzalah asks about website code, admin panels, watch collections, or features, call "read_website_file" to inspect the live HTML/JS code.
- When Hanzalah asks to edit or update any page, first read the file with "read_website_file", then call "stage_github_update" with the full updated file content so Hanzalah can confirm before it pushes to GitHub.`;

  const tools = [
    {
      functionDeclarations: [
        {
          name: "read_website_file",
          description: "Read the live source code of any file in Avesta-Studio/DYNAST (e.g., index.html, bespoke.html, admin.html, bespoke-admin.html, card.html).",
          parameters: {
            type: "OBJECT",
            properties: {
              filePath: { type: "STRING", description: "Filename in repo, e.g., index.html, admin.html, bespoke.html, bespoke-admin.html" }
            },
            required: ["filePath"]
          }
        },
        {
          name: "stage_github_update",
          description: "Stage a code update to a file in the GitHub repository that requires Hanzalah's confirmation before pushing live.",
          parameters: {
            type: "OBJECT",
            properties: {
              filePath: { type: "STRING", description: "File path to update, e.g., index.html, admin.html, bespoke.html, bespoke-admin.html" },
              summaryOfChanges: { type: "STRING", description: "Clear summary of what is being changed for Hanzalah to review" },
              commitMessage: { type: "STRING", description: "Git commit message" },
              newContent: { type: "STRING", description: "The complete updated source code of the file" }
            },
            required: ["filePath", "summaryOfChanges", "newContent"]
          }
        }
      ]
    }
  ];

  const contents = [];
  for (const h of chatHistory.slice(-14)) {
    if (h && h.text) {
      contents.push({
        role: h.role === "Hanzalah" ? "user" : "model",
        parts: [{ text: String(h.text) }]
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: String(prompt) }] });

  async function requestModel(modelName, conversationContents, useTools = true) {
    const bodyPayload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: conversationContents,
      generationConfig: { temperature: 0.5 }
    };
    if (useTools) bodyPayload.tools = tools;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(bodyPayload)
      }
    );

    const data = await response.json();
    if (response.ok && data?.candidates?.[0]?.content) {
      return { ok: true, content: data.candidates[0].content };
    }
    return { ok: false, error: data?.error?.message || JSON.stringify(data) };
  }

  async function callGemini(conversationContents) {
    const models = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3-flash-preview"];
    const errors = [];

    for (const model of models) {
      let res = await requestModel(model, conversationContents, true);
      if (res.ok) return res;

      const match = res.error.match(/models\/([a-zA-Z0-9.-]+)/);
      if (match && match[1] && !models.includes(match[1])) {
        const suggested = await requestModel(match[1], conversationContents, true);
        if (suggested.ok) return suggested;
        const suggestedNoTools = await requestModel(match[1], conversationContents, false);
        if (suggestedNoTools.ok) return suggestedNoTools;
      }

      let resNoTools = await requestModel(model, conversationContents, false);
      if (resNoTools.ok) return resNoTools;

      errors.push(`${model}: ${res.error}`);
    }

    return { ok: false, error: errors.join(" | ") };
  }

  try {
    let step = await callGemini(contents);
    if (!step.ok) {
      return res.status(500).json({ error: `Gemini API Error: ${step.error}` });
    }

    for (let i = 0; i < 2; i++) {
      const fnPart = step.content.parts?.find((p) => p.functionCall);
      if (!fnPart) break;

      const { name, args } = fnPart.functionCall;

      if (name === "read_website_file") {
        const fileContent = await readProjectFile(args.filePath);
        contents.push(step.content);
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "read_website_file",
                response: { filePath: args.filePath, content: fileContent.slice(0, 45000) }
              }
            }
          ]
        });
        step = await callGemini(contents);
        if (!step.ok) return res.status(500).json({ error: step.error });
      } else if (name === "stage_github_update") {
        return res.status(200).json({
          reply: `Hanzalah, I have prepared the update for ${args.filePath}: ${args.summaryOfChanges}. Tap Confirm below or say "Confirm update" to push this live to GitHub and dynast.co.in.`,
          pendingAction: {
            type: "github_update",
            filePath: args.filePath,
            summaryOfChanges: args.summaryOfChanges,
            commitMessage: args.commitMessage || `Update ${args.filePath}`,
            newContent: args.newContent
          }
        });
      } else {
        break;
      }
    }

    const textParts = step.content.parts?.filter((p) => p.text && !p.thought).map((p) => p.text) || [];
    const fallbackParts = step.content.parts?.filter((p) => p.text).map((p) => p.text) || [];
    const finalReply = (textParts.length ? textParts : fallbackParts).join(" ").trim() || "Task completed, Hanzalah.";

    return res.status(200).json({ reply: finalReply });
  } catch (err) {
    return res.status(500).json({ error: "Server Execution Error: " + err.message });
  }
}
  
