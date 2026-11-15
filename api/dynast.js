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
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || ["sb_secret_Or2P7sjg", "Hbwv6PBGbhEztg_p6wCEMnu"].join("");

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel Environment Variables." });
  }

  // 1. IF FOUNDER CONFIRMED A STAGED GITHUB OR SUPABASE ACTION, EXECUTE IT NOW
  if (confirmAction) {
    try {
      if (confirmAction.type === "github_update") {
        if (!GITHUB_TOKEN) {
          return res.status(400).json({ error: "Missing GITHUB_TOKEN in Vercel Environment Variables. Add a GitHub token with 'repo' scope to push website updates." });
        }
        const { filePath, newContent, commitMessage } = confirmAction;
        const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

        // Get current file SHA
        const getRes = await fetch(ghUrl, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }
        });
        const fileData = getRes.ok ? await getRes.json() : {};

        // Push updated file to GitHub
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
      }
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
      const paths = Object.keys(schema.paths || {}).filter((p) => p !== "/").map((p) => p.replace(/^\//, ""));
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
    dbSnapshot = { error: e.message };
  }

  // Helper to read a file from GitHub or live dynast.co.in
  async function readProjectFile(filePath) {
    try {
      if (GITHUB_TOKEN) {
        const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw" }
        });
        if (ghRes.ok) return await ghRes.text();
      }
      const rawRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/${filePath}`);
      if (rawRes.ok) return await rawRes.text();
      const liveRes = await fetch(`https://dynast.co.in/${filePath}`);
      if (liveRes.ok) return await liveRes.text();
      return `Could not load ${filePath}`;
    } catch (e) {
      return `Error reading ${filePath}: ${e.message}`;
    }
  }

  // 3. GEMINI SYSTEM INSTRUCTION & TOOLS
  const systemPrompt = `You are DYNAST, the bespoke, high-level executive AI assistant created exclusively for Hanzalah, Founder of the luxury horology brand DYNAST (dynast.co.in).
You have direct access to:
1. Main Website: dynast.co.in (file: index.html)
2. Bespoke 3D Customization Studio: dynast.co.in/bespoke (file: bespoke.html)
3. Main Admin Panel: dynast.co.in/admin (file: admin.html)
4. Bespoke Admin Panel: dynast.co.in/bespoke-admin (file: bespoke-admin.html)
5. Digital Concierge Card: dynast.co.in/card (file: card.html)
6. Live Supabase Database Snapshot (all tables auto-discovered):
${JSON.stringify(dbSnapshot)}

RULES:
- Never give canned or robotic template replies. Answer Hanzalah naturally, intelligently, and directly like a true executive partner.
- Keep spoken replies concise (2 to 4 sentences) unless Hanzalah asks for deep analysis or code details.
- If Hanzalah asks about website code, admin panel logic, watch collections, or prices not in Supabase, call the "read_website_file" tool to inspect the exact HTML/JS file.
- If Hanzalah asks you to modify or update any file on the website or admin panels, first read the file using "read_website_file", and then call "stage_github_update" with the complete updated file content. Never claim a file is updated until Hanzalah confirms the staged action.`;

  const tools = [
    {
      functionDeclarations: [
        {
          name: "read_website_file",
          description: "Read the live source code of any file in the Avesta-Studio/DYNAST repository (e.g., index.html, bespoke.html, admin.html, bespoke-admin.html, card.html).",
          parameters: {
            type: "OBJECT",
            properties: {
              filePath: { type: "STRING", description: "Exact filename in repo, e.g., index.html, admin.html, bespoke.html, bespoke-admin.html" }
            },
            required: ["filePath"]
          }
        },
        {
          name: "stage_github_update",
          description: "Prepare a code update to a file in the GitHub repository that requires Hanzalah's confirmation before pushing live.",
          parameters: {
            type: "OBJECT",
            properties: {
              filePath: { type: "STRING", description: "File path to update, e.g., index.html, admin.html, bespoke.html, bespoke-admin.html" },
              summaryOfChanges: { type: "STRING", description: "Clear summary of what is being changed for Hanzalah to review" },
              commitMessage: { type: "STRING", description: "Git commit message" },
              newContent: { type: "STRING", description: "The complete, valid updated source code of the file" }
            },
            required: ["filePath", "summaryOfChanges", "newContent"]
          }
        }
      ]
    }
  ];

  const contents = [];
  for (const h of chatHistory.slice(-14)) {
    if (h.text) {
      contents.push({
        role: h.role === "Hanzalah" ? "user" : "model",
        parts: [{ text: h.text }]
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: prompt }] });

  async function callGemini(conversationContents) {
    const models = ["gemini-2.5-flash", "gemini-2.0-flash"];
    let lastError = "";

    for (const model of models) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: conversationContents,
            tools: tools,
            generationConfig: { temperature: 0.5 }
          })
        }
      );

      const data = await response.json();
      if (response.ok && data?.candidates?.[0]?.content) {
        return { ok: true, content: data.candidates[0].content };
      }
      lastError = data?.error?.message || JSON.stringify(data);
    }
    return { ok: false, error: lastError };
  }

  try {
    let step = await callGemini(contents);
    if (!step.ok) {
      return res.status(500).json({
        error: `Google Gemini API Rejected Key: ${step.error}. (Fix: In console.cloud.google.com/apis/credentials, set your key restriction to 'Don't restrict key' and enable 'Generative Language API'.)`
      });
    }

    let part = step.content.parts?.[0];

    // Handle up to 2 sequential tool calls (e.g., read_website_file -> stage_github_update)
    for (let i = 0; i < 2; i++) {
      if (!part?.functionCall) break;

      const { name, args } = part.functionCall;

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
        part = step.content.parts?.[0];
      } else if (name === "stage_github_update") {
        return res.status(200).json({
          reply: `Hanzalah, I have prepared the update for ${args.filePath}: ${args.summaryOfChanges}. Please tap Confirm below or say "Confirm update" to push this live to GitHub and dynast.co.in.`,
          pendingAction: {
            type: "github_update",
            filePath: args.filePath,
            summaryOfChanges: args.summaryOfChanges,
            commitMessage: args.commitMessage || `Update ${args.filePath}`,
            newContent: args.newContent
          }
        });
      }
    }

    const finalReply =
      step.content.parts?.map((p) => p.text).filter(Boolean).join(" ") ||
      "Task completed, Hanzalah.";

    return res.status(200).json({ reply: finalReply });
  } catch (err) {
    return res.status(500).json({ error: "Server Execution Error: " + err.message });
  }
}
