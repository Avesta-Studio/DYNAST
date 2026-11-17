export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { prompt = "", chatHistory = [], confirmAction = null, ttsOnly = false, ttsText = "" } = req.body || {};

  const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
  const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
  const GITHUB_REPO = "Avesta-Studio/DYNAST";

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel Environment Variables." });
  }

  // Generates an instant, loud MP3 audio URL using Google's translate TTS backend (guaranteed unmuted audio)
  function getAudioUrl(text) {
    const clean = String(text || "").replace(/[*#_`~>]/g, "").trim().slice(0, 200);
    if (!clean) return null;
    return `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=en&client=tw-ob`;
  }

  if (ttsOnly && ttsText) {
    return res.status(200).json({ audioUrl: getAudioUrl(ttsText) });
  }

  if (confirmAction && confirmAction.type === "github_update") {
    try {
      const { filePath, newContent, commitMessage } = confirmAction;
      const cleanPath = filePath.replace(/^\/+/, "");
      const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${cleanPath}`;

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
          message: commitMessage || `DYNAST update to ${cleanPath}`,
          content: Buffer.from(newContent, "utf8").toString("base64"),
          sha: fileData.sha
        })
      });

      if (!putRes.ok) return res.status(500).json({ error: "GitHub Push Failed" });

      const replyMsg = `Done. The update to ${cleanPath} is now live on GitHub and deploying to dynast.co.in.`;
      return res.status(200).json({ reply: replyMsg, audioUrl: getAudioUrl(replyMsg) });
    } catch (err) {
      return res.status(500).json({ error: "GitHub Update Error: " + err.message });
    }
  }

  const nowIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" });
  const systemPrompt = `You are DYNAST, an ultra-intelligent, warm, and natural voice AI partner for Hanzalah, Founder of the luxury horology brand DYNAST (dynast.co.in). Current IST Time: ${nowIST}.
Speak naturally using contractions ("I'm", "we've"). Never repeat "Hanzalah" at the end of sentences. Keep spoken answers concise (1 to 2 sentences) with zero markdown symbols.`;

  const contents = [];
  for (const h of chatHistory.slice(-6)) {
    if (h && h.text && !String(h.text).includes("Error") && !String(h.text).includes("quota")) {
      contents.push({
        role: h.role === "Hanzalah" ? "user" : "model",
        parts: [{ text: String(h.text) }]
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: String(prompt) }] });

  const models = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
  let lastError = "";

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { temperature: 0.55, maxOutputTokens: 160 }
          })
        }
      );

      const data = await response.json();
      if (response.ok && data?.candidates?.[0]?.content?.parts) {
        const parts = data.candidates[0].content.parts;
        const textParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text);
        let replyText = (textParts.length ? textParts : parts.map((p) => p.text || "")).join(" ").trim();
        replyText = replyText.replace(/,\s*Hanzalah([.!?])$/i, "$1").trim() || "I'm online and ready.";

        return res.status(200).json({
          reply: replyText,
          audioUrl: getAudioUrl(replyText),
          modelUsed: model
        });
      }
      lastError = data?.error?.message || JSON.stringify(data);
    } catch (err) {
      lastError = err.message;
    }
  }

  return res.status(500).json({ error: `Gemini API Error: ${lastError}` });
}
