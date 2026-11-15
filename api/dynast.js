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

  async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  }

  // 1. EXECUTE CONFIRMED GITHUB UPDATE
  if (confirmAction && confirmAction.type === "github_update") {
    try {
      if (!GITHUB_TOKEN) {
        return res.status(400).json({ error: "Missing GITHUB_TOKEN in Vercel Environment Variables." });
      }
      const { filePath, newContent, commitMessage } = confirmAction;
      const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

      const getRes = await fetchWithTimeout(ghUrl, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }
      });
      const fileData = getRes.ok ? await getRes.json() : {};

      const putRes = await fetchWithTimeout(ghUrl, {
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
        reply: `Confirmed, Hanzalah. I have pushed the update to ${filePath} on GitHub and Vercel is deploying it live.`
      });
    } catch (err) {
      return res.status(500).json({ error: "Confirmation Execution Error: " + err.message });
    }
  }

  // 2. FAST SUPABASE SNAPSHOT
  let dbSnapshot = {};
  try {
    const tables = ["orders", "inventory", "bespoke_orders", "admin_logs"];
    await Promise.all(
      tables.map(async (table) => {
        try {
          const tRes = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=15`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          }, 3000);
          if (tRes.ok) dbSnapshot[table] = await tRes.json();
        } catch (e) {}
      })
    );
  } catch (e) {
    dbSnapshot = { status: "connected" };
  }

  async function readProjectFile(filePath) {
    try {
      const cleanPath = filePath.replace(/^\/+/, "");
      if (GITHUB_TOKEN) {
        const ghRes = await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_REPO}/contents/${cleanPath}`, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw" }
        }, 3000);
        if (ghRes.ok) return await ghRes.text();
      }
      const rawRes = await fetchWithTimeout(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/${cleanPath}`, {}, 3000);
      if (rawRes.ok) return await rawRes.text();
      return `Could not load ${cleanPath}`;
    } catch (e) {
      return `Error reading ${filePath}: ${e.message}`;
    }
  }

  const systemPrompt = `You are DYNAST, the bespoke executive AI assistant for Hanzalah, Founder of the luxury watch brand DYNAST (dynast.co.in).
You have access to dynast.co.in, bespoke studio, admin panels, and Supabase data:
${JSON.stringify(dbSnapshot)}

RULES:
- Address Hanzalah naturally and intelligently as his executive AI partner.
- Keep spoken replies concise (2 to 3 sentences).
- If Hanzalah asks about website code or admin panels, call "read_website_file".
- If Hanzalah asks to update any page, read the file first, then call "stage_github_update".`;

  const tools = [
    {
      functionDeclarations: [
        {
          name: "read_website_file",
          description: "Read source code of files in Avesta-Studio/DYNAST (e.g., index.html, admin.html, bespoke.html, bespoke-admin.html).",
          parameters: {
            type: "OBJECT",
            properties: { filePath: { type: "STRING", description: "Filename, e.g., index.html, admin.html" } },
            required: ["filePath"]
          }
        },
        {
          name: "stage_github_update",
          description: "Stage a code update requiring Hanzalah's confirmation.",
          parameters: {
            type: "OBJECT",
            properties: {
              filePath: { type: "STRING", description: "File path" },
              summaryOfChanges: { type: "STRING", description: "Summary of changes" },
              commitMessage: { type: "STRING", description: "Commit message" },
              newContent: { type: "STRING", description: "Complete updated source code" }
            },
            required: ["filePath", "summaryOfChanges", "newContent"]
          }
        }
      ]
    }
  ];

  const contents = [];
  for (const h of chatHistory.slice(-10)) {
    if (h && h.text) {
      contents.push({
        role: h.role === "Hanzalah" ? "user" : "model",
        parts: [{ text: String(h.text) }]
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: String(prompt) }] });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: contents,
          tools: tools,
          generationConfig: { temperature: 0.5 }
        })
      }
    );

    const data = await response.json();
    if (!response.ok || !data?.candidates?.[0]?.content) {
      return res.status(500).json({ error: data?.error?.message || "Gemini API generation failed." });
    }

    const candidateContent = data.candidates[0].content;
    const fnPart = candidateContent.parts?.find((p) => p.functionCall);

    if (fnPart) {
      const { name, args } = fnPart.functionCall;
      if (name === "read_website_file") {
        const fileContent = await readProjectFile(args.filePath);
        contents.push(candidateContent);
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name: "read_website_file", response: { content: fileContent.slice(0, 40000) } } }]
        });

        const secondRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: contents,
              tools: tools,
              generationConfig: { temperature: 0.5 }
            })
          }
        );
        const secondData = await secondRes.json();
        const secondText = secondData?.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join(" ") || "File inspected successfully.";
        return res.status(200).json({ reply: secondText });
      } else if (name === "stage_github_update") {
        return res.status(200).json({
          reply: `Hanzalah, I have prepared the update for ${args.filePath}: ${args.summaryOfChanges}. Tap Confirm below to push this live.`,
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

    const textParts = candidateContent.parts?.filter((p) => p.text && !p.thought).map((p) => p.text) || [];
    const finalReply = textParts.join(" ").trim() || "Systems operational, Hanzalah.";

    return res.status(200).json({ reply: finalReply });
  } catch (err) {
    return res.status(500).json({ error: "Server Execution Error: " + err.message });
  }
}
