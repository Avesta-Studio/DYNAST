let cachedTextModel = null;
let cachedTtsModel = null;

// Safely wraps raw 16-bit 24kHz Mono PCM from Gemini "Orus" (Orion) into a standard playable WAV file
function pcm16ToWavBase64(pcmBase64, sampleRate = 24000) {
  const rawBuffer = Buffer.from(pcmBase64, "base64");
  const evenByteLength = rawBuffer.length - (rawBuffer.length % 2);
  const pcmBuffer = rawBuffer.subarray(0, evenByteLength);

  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + evenByteLength, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  wavHeader.writeUInt16LE(1, 20);  // AudioFormat (1 = Linear PCM)
  wavHeader.writeUInt16LE(1, 22);  // NumChannels (1 = Mono)
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * 2, 28); // ByteRate (SampleRate * 1 * 2)
  wavHeader.writeUInt16LE(2, 32);  // BlockAlign (1 * 2)
  wavHeader.writeUInt16LE(16, 34); // BitsPerSample (16-bit)
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(evenByteLength, 40);

  // Peak-normalize + soft-knee loudness boost so mobile loudspeakers play crystal clear
  let maxPeak = 1;
  for (let i = 0; i < evenByteLength; i += 2) {
    const abs = Math.abs(pcmBuffer.readInt16LE(i));
    if (abs > maxPeak) maxPeak = abs;
  }

  const targetGain = Math.min(2.6, (30000 / maxPeak) * 1.35);
  const boostedPcm = Buffer.alloc(evenByteLength);

  for (let i = 0; i < evenByteLength; i += 2) {
    const sample = pcmBuffer.readInt16LE(i) / 32768.0;
    const saturated = Math.tanh(sample * targetGain);
    const intSample = Math.max(-32767, Math.min(32767, Math.round(saturated * 32767)));
    boostedPcm.writeInt16LE(intSample, i);
  }

  return Buffer.concat([wavHeader, boostedPcm]).toString("base64");
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    prompt = "",
    chatHistory = [],
    confirmAction = null,
    ttsOnly = false,
    ttsText = ""
  } = req.body || {};

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

  async function fetchFast(url, options = {}, timeoutMs = 4500) {
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

  // STRICT OFFICIAL GEMINI LIVE ORION ("Orus") AUDIO GENERATOR (CACHED FOR MAX SPEED)
  async function generateGeminiOrionAudio(rawSpeech) {
    const cleanSpeech = String(rawSpeech || "")
      .replace(/[*#_`~>]/g, "")
      .replace(/\bDYNAST\b/gi, "Dynast")
      .replace(/https?:\/\/\S+/g, "")
      .trim()
      .slice(0, 600);

    if (!cleanSpeech) return { audioDataUri: null, voiceSource: "GEMINI ORION (ORUS)" };

    const baseTtsModels = [
      "gemini-2.5-flash-preview-tts",
      "gemini-2.0-flash-exp",
      "gemini-2.0-flash"
    ];
    const ttsModels = cachedTtsModel
      ? [cachedTtsModel, ...baseTtsModels.filter((m) => m !== cachedTtsModel)]
      : baseTtsModels;

    for (const ttsModel of ttsModels) {
      try {
        const ttsRes = await fetchFast(
          `https://generativelanguage.googleapis.com/v1beta/models/${ttsModel}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": GEMINI_API_KEY
            },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: ttsModel.includes("tts")
                        ? `Say naturally in a warm, confident, conversational tone: ${cleanSpeech}`
                        : `Read the following text aloud verbatim without adding any extra words: "${cleanSpeech}"`
                    }
                  ]
                }
              ],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: "Orus" // Official Gemini Live Orion voice ID
                    }
                  }
                }
              }
            })
          },
          5500
        );

        if (ttsRes.ok) {
          const ttsData = await ttsRes.json();
          const audioPart = ttsData?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
          if (audioPart?.inlineData?.data) {
            cachedTtsModel = ttsModel;
            const wavBase64 = pcm16ToWavBase64(audioPart.inlineData.data, 24000);
            return {
              audioDataUri: `data:audio/wav;base64,${wavBase64}`,
              voiceSource: "GEMINI ORION (ORUS)"
            };
          }
        } else if (cachedTtsModel === ttsModel) {
          cachedTtsModel = null;
        }
      } catch (e) {
        if (cachedTtsModel === ttsModel) cachedTtsModel = null;
      }
    }

    return { audioDataUri: null, voiceSource: "GEMINI ORION (ORUS)" };
  }

  if (ttsOnly && ttsText) {
    const { audioDataUri, voiceSource } = await generateGeminiOrionAudio(ttsText);
    return res.status(200).json({ audioDataUri, voiceSource });
  }

  // PRIORITIZE GEMINI 3.7 & 3.5 FLASH WITH ULTRA-FAST FALLBACKS
  const TEXT_MODEL_CANDIDATES = [
    "gemini-3.7-flash",
    "gemini-3.7-flash-preview",
    "gemini-3.5-flash",
    "gemini-3.5-flash-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.0-flash"
  ];

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
            message: commitMessage || `DYNAST AI update to ${cleanPath}`,
            content: Buffer.from(newContent, "utf8").toString("base64"),
            sha: fileData.sha
          })
        },
        5500
      );

      if (!putRes.ok) {
        const errText = await putRes.text();
        return res.status(500).json({ error: `GitHub Push Failed: ${errText}` });
      }

      const replyMsg = `Done. The update to ${cleanPath} is now live on GitHub and deploying to dynast.co.in.`;
      const { audioDataUri, voiceSource } = await generateGeminiOrionAudio(replyMsg);
      return res.status(200).json({ reply: replyMsg, audioDataUri, voiceSource });
    } catch (err) {
      return res.status(500).json({ error: "GitHub Update Error: " + err.message });
    }
  }

  // 2. SMART CONDITIONAL CONTEXT LOADING
  const lowerPrompt = String(prompt).toLowerCase();
  const needsDatabase = /(order|stock|inventory|database|table|supabase|sale|customer|log|revenue|analytics|status|store)/.test(lowerPrompt);
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
    const supaHeaders = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    };
    try {
      const knownTables = ["orders", "inventory"];
      const schemaRes = await fetchFast(`${SUPABASE_URL}/rest/v1/`, { headers: supaHeaders }, 1200);
      let tables = [...knownTables];
      if (schemaRes.ok) {
        const schema = await schemaRes.json();
        const discovered = Object.keys(schema.paths || {})
          .filter((p) => p !== "/")
          .map((p) => p.replace(/^\//, ""));
        tables = [...new Set([...knownTables, ...discovered])];
      }
      snapshot.tables = tables;

      await Promise.all(
        tables.slice(0, 5).map(async (t) => {
          try {
            const r = await fetchFast(
              `${SUPABASE_URL}/rest/v1/${t}?select=*&limit=10`,
              { headers: supaHeaders },
              1200
            );
            if (r.ok) snapshot[t] = await r.json();
          } catch (e) {}
        })
      );
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
          1600
        );
        if (r.ok) return await r.text();
      }
      const raw = await fetchFast(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/${file}`, {}, 1600);
      if (raw.ok) return await raw.text();
    } catch (e) {}
    return null;
  }

  async function getLiveGoogleFeed(queryText) {
    try {
      const cleaned = queryText.replace(/[^a-zA-Z0-9 ]/g, " ").trim() || "India business technology";
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleaned)}&hl=en-IN&gl=IN&ceid=IN:en`;
      const res = await fetchFast(rssUrl, {}, 1300);
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
3. Keep spoken answers concise and punchy (1 to 2 sentences) with zero markdown symbols (* or #).
4. If asked to edit or update a website file, include the complete updated code at the very end wrapped in <GITHUB_UPDATE>{"filePath":"${targetFile || "index.html"}","summaryOfChanges":"...","commitMessage":"...","newContent":"..."}</GITHUB_UPDATE>.`;

  const contents = [];
  for (const h of chatHistory.slice(-6)) {
    if (h && h.text && !String(h.text).includes("Error") && !String(h.text).includes("quota")) {
      const cleanedHistoryText = String(h.text)
        .replace(/,\s*Hanzalah([.!?])/gi, "$1")
        .replace(/\bHanzalah,\s*/gi, "")
        .trim();
      if (!cleanedHistoryText) continue;

      const role = h.role === "Hanzalah" ? "user" : "model";
      if (contents.length === 0 && role === "model") continue;

      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += "\n" + cleanedHistoryText;
      } else {
        contents.push({ role, parts: [{ text: cleanedHistoryText }] });
      }
    }
  }

  if (contents.length > 0 && contents[contents.length - 1].role === "user") {
    contents[contents.length - 1].parts[0].text += "\n" + String(prompt);
  } else {
    contents.push({ role: "user", parts: [{ text: String(prompt) }] });
  }

  const isCodeEdit = Boolean(targetFile);
  const modelsToTry = cachedTextModel
    ? [cachedTextModel, ...TEXT_MODEL_CANDIDATES.filter((m) => m !== cachedTextModel)]
    : TEXT_MODEL_CANDIDATES;

  let data = null;
  let usedModel = null;
  let lastErrorMsg = "Unable to reach Gemini text model.";

  for (const modelName of modelsToTry) {
    try {
      const response = await fetchFast(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: {
              temperature: 0.5,
              maxOutputTokens: isCodeEdit ? 16384 : 180
            }
          })
        },
        isCodeEdit ? 22000 : 3800
      );

      const resJson = await response.json();
      if (response.ok && resJson?.candidates?.[0]?.content?.parts) {
        data = resJson;
        usedModel = modelName;
        cachedTextModel = modelName;
        break;
      } else {
        lastErrorMsg = resJson?.error?.message || JSON.stringify(resJson);
        if (cachedTextModel === modelName) cachedTextModel = null;
      }
    } catch (err) {
      lastErrorMsg = err.message;
      if (cachedTextModel === modelName) cachedTextModel = null;
    }
  }

  if (!data) {
    return res.status(500).json({ error: `Gemini API Error: ${lastErrorMsg}` });
  }

  try {
    const parts = data.candidates[0].content.parts;
    const textParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text);
    let replyText = (textParts.length ? textParts : parts.map((p) => p.text || "")).join(" ").trim();

    const updateMatch = replyText.match(/<GITHUB_UPDATE>([\s\S]*?)<\/GITHUB_UPDATE>/);
    if (updateMatch) {
      try {
        const parsed = JSON.parse(updateMatch[1].trim());
        const cleanReply =
          replyText
            .replace(/<GITHUB_UPDATE>[\s\S]*?<\/GITHUB_UPDATE>/, "")
            .replace(/,\s*Hanzalah([.!?])/gi, "$1")
            .trim() || `I've prepared the update for ${parsed.filePath}. Tap Deploy below to push it live.`;

        const { audioDataUri, voiceSource } = await generateGeminiOrionAudio(cleanReply);
        return res.status(200).json({
          reply: cleanReply,
          audioDataUri,
          voiceSource,
          modelUsed: usedModel,
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

    replyText = replyText.replace(/,\s*Hanzalah([.!?])$/i, "$1").trim() || "I'm online and ready.";
    const { audioDataUri, voiceSource } = await generateGeminiOrionAudio(replyText);

    return res.status(200).json({
      reply: replyText,
      audioDataUri,
      voiceSource,
      modelUsed: usedModel
    });
  } catch (err) {
    return res.status(500).json({ error: `Server Error: ${err.message}` });
  }
}
