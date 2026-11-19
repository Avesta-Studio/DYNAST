let cachedTextModel = null;
let cachedTtsModel = null;
const failedModels = new Map(); // modelName -> timestamp
const FAIL_TTL_MS = 10 * 60 * 1000;

function isModelCoolingDown(modelName) {
  const failedAt = failedModels.get(modelName);
  if (!failedAt) return false;
  if (Date.now() - failedAt > FAIL_TTL_MS) {
    failedModels.delete(modelName);
    return false;
  }
  return true;
}

function extractSampleRate(mimeType = "") {
  const match = String(mimeType).match(/rate=(\d+)/i);
  const parsed = match ? Number(match[1]) : 24000;
  return Number.isFinite(parsed) && parsed >= 8000 && parsed <= 96000 ? parsed : 24000;
}

// Wraps raw 16-bit Mono PCM from Orion ("Orus") into a clean, noise-safe playable WAV
function pcm16ToWavBase64(pcmBase64, sampleRate = 24000) {
  const rawBuffer = Buffer.from(pcmBase64, "base64");
  const evenByteLength = rawBuffer.length - (rawBuffer.length % 2);
  const pcmBuffer = rawBuffer.subarray(0, evenByteLength);

  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + evenByteLength, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * 2, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(evenByteLength, 40);

  let maxPeak = 1;
  for (let i = 0; i < evenByteLength; i += 2) {
    const abs = Math.abs(pcmBuffer.readInt16LE(i));
    if (abs > maxPeak) maxPeak = abs;
  }

  // Noise-floor guard prevents boosting quiet hiss on mobile speakers/earbuds
  const effectivePeak = Math.max(maxPeak, 1400);
  const targetGain = Math.min(1.9, (28000 / effectivePeak) * 1.15);
  const boostedPcm = Buffer.allocUnsafe(evenByteLength);

  for (let i = 0; i < evenByteLength; i += 2) {
    const sample = pcmBuffer.readInt16LE(i) / 32768.0;
    const saturated = Math.tanh(sample * targetGain);
    const intSample = Math.max(-32767, Math.min(32767, Math.round(saturated * 32767)));
    boostedPcm.writeInt16LE(intSample, i);
  }

  return Buffer.concat([wavHeader, boostedPcm]).toString("base64");
}

// Strips huge base64 images or long blobs from Supabase rows so analytics stay fast and within token limits
function sanitizeValue(val) {
  if (typeof val === "string") {
    if (val.startsWith("data:image") || val.length > 260) {
      return val.startsWith("data:image") ? "[image-data]" : `${val.slice(0, 240)}...`;
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.slice(0, 8).map(sanitizeValue);
  }
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = sanitizeValue(v);
    }
    return out;
  }
  return val;
}

// Computes exact server-side metrics so DYNAST reports accurate Admin Panel numbers
function summarizeTable(rows) {
  if (!Array.isArray(rows)) return { count: 0, latest: [] };

  const statusCounts = {};
  const lowStock = [];
  let totalRevenue = 0;
  let revenueDetected = false;

  const revenueKeys = ["total_amount", "grand_total", "total_price", "total", "amount", "price"];
  const statusKeys = ["status", "order_status", "payment_status", "fulfillment_status"];
  const stockKeys = ["stock", "quantity", "qty", "stock_count", "available_stock"];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    for (const sk of statusKeys) {
      if (row[sk] !== undefined && row[sk] !== null && String(row[sk]).trim() !== "") {
        const label = String(row[sk]).trim().toLowerCase();
        statusCounts[label] = (statusCounts[label] || 0) + 1;
        break;
      }
    }

    for (const rk of revenueKeys) {
      if (row[rk] !== undefined && row[rk] !== null) {
        const num = Number(String(row[rk]).replace(/[^0-9.-]/g, ""));
        if (Number.isFinite(num) && num > 0) {
          totalRevenue += num;
          revenueDetected = true;
          break;
        }
      }
    }

    for (const qk of stockKeys) {
      if (row[qk] !== undefined && row[qk] !== null) {
        const qty = Number(row[qk]);
        if (Number.isFinite(qty) && qty <= 5) {
          lowStock.push({
            item: row.name || row.title || row.sku || row.model || row.id || "Item",
            stock: qty
          });
        }
        break;
      }
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const timeA = Date.parse(a?.created_at || a?.updated_at || a?.date || "") || Number(a?.id) || 0;
    const timeB = Date.parse(b?.created_at || b?.updated_at || b?.date || "") || Number(b?.id) || 0;
    return timeB - timeA;
  });

  const summary = {
    totalRows: rows.length,
    latestRecords: sorted.slice(0, 12).map(sanitizeValue)
  };
  if (Object.keys(statusCounts).length) summary.statusBreakdown = statusCounts;
  if (revenueDetected) summary.computedTotalValue = Math.round(totalRevenue * 100) / 100;
  if (lowStock.length) summary.lowStockItems = lowStock.slice(0, 15);

  return summary;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    prompt = "",
    chatHistory = [],
    confirmAction = null,
    ttsOnly = false,
    ttsText = "",
    verifyPin = false,
    pin = ""
  } = req.body || {};

  const FOUNDER_PIN = (process.env.DYNAST_PIN || "060709").trim();
  const providedPin = String(req.headers["x-dynast-pin"] || pin || "").trim();

  if (verifyPin) {
    if (providedPin === FOUNDER_PIN) {
      return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ error: "Invalid passcode." });
  }

  if (providedPin !== FOUNDER_PIN) {
    return res.status(401).json({ error: "Unauthorized session. Please unlock again." });
  }

  const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
  const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
  const GITHUB_REPO = (process.env.GITHUB_REPO || "Avesta-Studio/DYNAST").trim();
  const SUPABASE_URL = (
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szdfipypoanrcbwaoqdy.supabase.co"
  ).replace(/\/+$/, "");
  const SUPABASE_KEY = (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    ""
  ).trim();

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel Environment Variables." });
  }

  async function fetchFast(url, options = {}, timeoutMs = 6000) {
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

  // OFFICIAL ORION ("Orus") VOICE SYNTHESIS — SAME VOICE AS VOCAL CHAT
  async function generateOrionAudio(rawSpeech) {
    const cleanSpeech = String(rawSpeech || "")
      .replace(/[*#_`~>\[\]]/g, "")
      .replace(/\bDYNAST\b/gi, "Dynast")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 700);

    if (!cleanSpeech) return { audioDataUri: null, voiceSource: "ORION" };

    const baseTtsModels = [
      process.env.GEMINI_TTS_MODEL,
      "gemini-2.5-flash-preview-tts",
      "gemini-2.5-pro-preview-tts",
      "gemini-2.0-flash-exp"
    ].filter(Boolean);

    const ttsModels = cachedTtsModel
      ? [cachedTtsModel, ...baseTtsModels.filter((m) => m !== cachedTtsModel)]
      : baseTtsModels;

    for (const ttsModel of ttsModels) {
      if (isModelCoolingDown(ttsModel) && ttsModel !== cachedTtsModel) continue;

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
                        ? `Speak calmly, warmly, and naturally: ${cleanSpeech}`
                        : `Read aloud verbatim with a calm, refined tone: "${cleanSpeech}"`
                    }
                  ]
                }
              ],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: "Orus"
                    }
                  }
                }
              }
            })
          },
          8500
        );

        if (ttsRes.ok) {
          const ttsData = await ttsRes.json();
          const audioPart = ttsData?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
          if (audioPart?.inlineData?.data) {
            cachedTtsModel = ttsModel;
            const sampleRate = extractSampleRate(audioPart.inlineData.mimeType);
            const wavBase64 = pcm16ToWavBase64(audioPart.inlineData.data, sampleRate);
            return {
              audioDataUri: `data:audio/wav;base64,${wavBase64}`,
              voiceSource: "ORION"
            };
          }
        } else {
          if (ttsRes.status === 404 || ttsRes.status === 400) failedModels.set(ttsModel, Date.now());
          if (cachedTtsModel === ttsModel) cachedTtsModel = null;
        }
      } catch (err) {
        if (cachedTtsModel === ttsModel) cachedTtsModel = null;
      }
    }

    return { audioDataUri: null, voiceSource: "ORION" };
  }

  if (ttsOnly && ttsText) {
    const { audioDataUri, voiceSource } = await generateOrionAudio(ttsText);
    return res.status(200).json({ audioDataUri, voiceSource });
  }

  // 1. EXECUTE CONFIRMED GITHUB UPDATE (PROTECTED BY PIN)
  if (confirmAction && confirmAction.type === "github_update") {
    try {
      if (!GITHUB_TOKEN) {
        return res.status(400).json({ error: "Missing GITHUB_TOKEN in Vercel Environment Variables." });
      }
      const { filePath, newContent, commitMessage } = confirmAction;
      if (!filePath || typeof newContent !== "string" || !newContent.trim()) {
        return res.status(400).json({ error: "Invalid deployment payload." });
      }

      const cleanPath = String(filePath).replace(/^\/+/, "");
      const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${cleanPath}`;

      const getRes = await fetchFast(
        ghUrl,
        { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } },
        4500
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
        7000
      );

      if (!putRes.ok) {
        const errText = await putRes.text();
        return res.status(500).json({ error: `GitHub Push Failed: ${errText}` });
      }

      const replyMsg = `Done. The update to ${cleanPath} is now live on GitHub and deploying to dynast.co.in.`;
      const { audioDataUri, voiceSource } = await generateOrionAudio(replyMsg);
      return res.status(200).json({ reply: replyMsg, audioDataUri, voiceSource });
    } catch (err) {
      return res.status(500).json({ error: `GitHub Update Error: ${err.message}` });
    }
  }

  if (!String(prompt).trim()) {
    return res.status(400).json({ error: "Prompt cannot be empty." });
  }

  // 2. SMART CONTEXT DETECTION
  const lowerPrompt = String(prompt).toLowerCase();
  const needsDatabase =
    /(admin|panel|dashboard|order|stock|inventory|database|table|supabase|sale|sales|customer|client|revenue|profit|analytics|analyse|analyze|report|status|store|bespoke|watch|watches|pending|shipped|delivered|product|products|business)/.test(
      lowerPrompt
    );

  const wantsCodeEdit =
    /(edit|update|change|modify|fix|redesign|add|remove|replace|code|deploy|push)/.test(lowerPrompt);

  let targetFile = null;
  if (wantsCodeEdit) {
    if (lowerPrompt.includes("bespoke-admin") || lowerPrompt.includes("bespoke admin")) {
      targetFile = "bespoke-admin.html";
    } else if (lowerPrompt.includes("admin.html") || (lowerPrompt.includes("admin") && lowerPrompt.includes("code"))) {
      targetFile = "admin.html";
    } else if (lowerPrompt.includes("bespoke.html") || (lowerPrompt.includes("bespoke") && lowerPrompt.includes("page"))) {
      targetFile = "bespoke.html";
    } else if (lowerPrompt.includes("card.html") || lowerPrompt.includes("digital card")) {
      targetFile = "card.html";
    } else if (/(index\.html|website code|main site|homepage|update.*site|edit.*site|change.*site)/.test(lowerPrompt)) {
      targetFile = "index.html";
    }
  }

  // 3. DEEP SUPABASE ADMIN PANEL DATA ANALYZER
  async function getSupabaseData() {
    if (!needsDatabase) return null;
    if (!SUPABASE_KEY) {
      return { warning: "SUPABASE_SECRET_KEY is not configured in Vercel Environment Variables." };
    }

    const snapshot = { tables: [], analytics: {} };
    const supaHeaders = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    };

    try {
      const defaultTables = ["orders", "inventory", "bespoke_orders", "products", "customers"];
      let discovered = [];

      try {
        const schemaRes = await fetchFast(`${SUPABASE_URL}/rest/v1/`, { headers: supaHeaders }, 2500);
        if (schemaRes.ok) {
          const schema = await schemaRes.json();
          discovered = Object.keys(schema.paths || {})
            .filter((p) => p !== "/" && !p.startsWith("/rpc/"))
            .map((p) => p.replace(/^\//, ""));
        }
      } catch (e) {
        console.error("Supabase schema lookup failed:", e.message);
      }

      const tablesToQuery = discovered.length
        ? [...new Set([...discovered, ...defaultTables])]
        : defaultTables;

      await Promise.all(
        tablesToQuery.slice(0, 8).map(async (tableName) => {
          try {
            const r = await fetchFast(
              `${SUPABASE_URL}/rest/v1/${encodeURIComponent(tableName)}?select=*&limit=200`,
              { headers: supaHeaders },
              3000
            );
            if (r.ok) {
              const rows = await r.json();
              if (Array.isArray(rows)) {
                snapshot.tables.push(tableName);
                snapshot.analytics[tableName] = summarizeTable(rows);
              }
            }
          } catch (e) {
            console.error(`Supabase table ${tableName} error:`, e.message);
          }
        })
      );
    } catch (e) {
      console.error("Supabase fetch error:", e.message);
    }

    return snapshot;
  }

  async function getGithubFile(file) {
    if (!file) return null;
    try {
      if (GITHUB_TOKEN) {
        const r = await fetchFast(
          `https://api.github.com/repos/${GITHUB_REPO}/contents/${file}`,
          { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3.raw" } },
          3000
        );
        if (r.ok) return await r.text();
      }
      const raw = await fetchFast(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/${file}`, {}, 3000);
      if (raw.ok) return await raw.text();
    } catch (e) {
      console.error("GitHub read error:", e.message);
    }
    return null;
  }

  async function getFallbackGoogleNews(queryText) {
    try {
      const cleaned = String(queryText).replace(/[^\p{L}\p{N} ]/gu, " ").trim() || "India world business technology";
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleaned)}&hl=en-IN&gl=IN&ceid=IN:en`;
      const res = await fetchFast(rssUrl, {}, 2500);
      if (!res.ok) return null;
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<\/item>/g)]
        .slice(0, 6)
        .map((m) => `${m[1].replace(/<!\[CDATA\[|\]\]>/g, "")} (${m[2]})`);
      return items.length ? items.join(" | ") : null;
    } catch (e) {
      return null;
    }
  }

  const [dbData, fileCode] = await Promise.all([getSupabaseData(), getGithubFile(targetFile)]);

  const nowIST = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short"
  });

  const isCodeEdit = Boolean(targetFile && fileCode);

  const systemPrompt = `You are DYNAST, a calm, refined, ultra-capable executive voice AI partner for Hanzalah, Founder of the luxury horology brand DYNAST (dynast.co.in).
Current Live Date & Time (IST): ${nowIST}.

ECOSYSTEM:
- Main Storefront: dynast.co.in (index.html)
- Bespoke 3D Studio: dynast.co.in/bespoke (bespoke.html)
- Main Admin Panel: dynast.co.in/admin (admin.html)
- Bespoke Admin Panel: dynast.co.in/bespoke-admin (bespoke-admin.html)
- Digital Concierge Card: dynast.co.in/card (card.html)
${dbData ? `\nLIVE ADMIN PANEL DATABASE & ANALYTICS:\n${JSON.stringify(dbData).slice(0, 24000)}` : ""}
${fileCode ? `\nSOURCE CODE OF ${targetFile}:\n${fileCode.slice(0, 28000)}` : ""}

BEHAVIOR & VOICE RULES:
1. Speak like a calm, articulate luxury concierge in live conversation using natural phrasing and contractions ("I'm", "we've", "it's").
2. Never mention AI providers, model names, or technical stack labels unless explicitly asked.
3. Do NOT repeat the founder's name ("Hanzalah") in normal replies unless he specifically asks who he is.
4. Keep spoken replies crisp, complete, and conversational (2 to 4 clear sentences max) with zero markdown symbols (*, #, backticks, or bullet points). Never cut off mid-thought.
5. When analyzing Admin Panel data, cite exact counts, statuses, revenue figures, and low-stock alerts directly from the live database snapshot above. If a table is empty or unavailable, state that plainly.
6. Use live Google Search grounding automatically for world events, news, market prices, weather, facts, or anything outside DYNAST's database.
${
  isCodeEdit
    ? `7. Since the founder requested an edit to ${targetFile}, append the complete updated file at the very end wrapped strictly in: <GITHUB_UPDATE>{"filePath":"${targetFile}","summaryOfChanges":"...","commitMessage":"...","newContent":"..."}</GITHUB_UPDATE>.`
    : ""
}`;

  // Normalize chat history (supports both new "user"/"assistant" and legacy "Hanzalah"/"DYNAST")
  const contents = [];
  for (const h of (Array.isArray(chatHistory) ? chatHistory : []).slice(-8)) {
    if (!h || !h.text) continue;
    const raw = String(h.text).trim();
    if (!raw || raw.includes("Error:") || raw.includes("quota")) continue;

    const role = h.role === "user" || h.role === "Hanzalah" ? "user" : "model";
    if (contents.length === 0 && role === "model") continue;

    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += "\n" + raw;
    } else {
      contents.push({ role, parts: [{ text: raw }] });
    }
  }

  if (contents.length > 0 && contents[contents.length - 1].role === "user") {
    contents[contents.length - 1].parts[0].text += "\n" + String(prompt).trim();
  } else {
    contents.push({ role: "user", parts: [{ text: String(prompt).trim() }] });
  }

  // Prioritizes gemini-3.8-flash first, with automatic instant fallback to live Flash models
  const baseTextModels = [
    process.env.GEMINI_TEXT_MODEL,
    "gemini-3.8-flash",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.0-flash"
  ].filter(Boolean);

  const modelsToTry = cachedTextModel
    ? [cachedTextModel, ...baseTextModels.filter((m) => m !== cachedTextModel)]
    : baseTextModels;

  async function invokeTextModel(modelName, useSearchTool, useZeroThinking, extraContext = "") {
    const body = {
      systemInstruction: {
        parts: [{ text: extraContext ? `${systemPrompt}\n${extraContext}` : systemPrompt }]
      },
      contents,
      generationConfig: {
        temperature: 0.45,
        maxOutputTokens: isCodeEdit ? 16384 : 650
      }
    };

    if (useZeroThinking && !isCodeEdit) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    if (useSearchTool && !isCodeEdit) {
      body.tools = [{ google_search: {} }];
    }

    const response = await fetchFast(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(body)
      },
      isCodeEdit ? 24000 : 12000
    );

    const resJson = await response.json().catch(() => ({}));
    return { response, resJson };
  }

  let data = null;
  let lastErrorMsg = "Unable to reach intelligence core.";

  for (const modelName of modelsToTry) {
    if (isModelCoolingDown(modelName) && modelName !== cachedTextModel) continue;

    try {
      // Attempt 1: Native Google Search Grounding + zero-thinking low latency
      let { response, resJson } = await invokeTextModel(modelName, !isCodeEdit, !isCodeEdit);

      // Attempt 2: If model rejects thinkingConfig or google_search with 400, retry cleanly
      if (!response.ok && response.status === 400) {
        const errMsg = String(resJson?.error?.message || "").toLowerCase();
        if (errMsg.includes("thinking") || errMsg.includes("google_search") || errMsg.includes("tool")) {
          const rssBackup = errMsg.includes("google_search") || errMsg.includes("tool")
            ? await getFallbackGoogleNews(prompt)
            : null;
          const retryContext = rssBackup ? `LIVE WORLD FEED:\n${rssBackup}` : "";
          const retry = await invokeTextModel(
            modelName,
            !errMsg.includes("google_search") && !errMsg.includes("tool") && !isCodeEdit,
            !errMsg.includes("thinking") && !isCodeEdit,
            retryContext
          );
          response = retry.response;
          resJson = retry.resJson;
        }
      }

      if (response.ok && resJson?.candidates?.[0]?.content?.parts) {
        data = resJson;
        cachedTextModel = modelName;
        break;
      } else {
        lastErrorMsg = resJson?.error?.message || `HTTP ${response.status}`;
        if (response.status === 404) {
          failedModels.set(modelName, Date.now());
        }
        if (cachedTextModel === modelName) cachedTextModel = null;
      }
    } catch (err) {
      lastErrorMsg = err.message;
      if (cachedTextModel === modelName) cachedTextModel = null;
    }
  }

  if (!data) {
    return res.status(502).json({ error: `Core unreachable: ${lastErrorMsg}` });
  }

  try {
    const parts = data.candidates[0].content.parts;
    const textParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text);
    let replyText = (textParts.length ? textParts : parts.map((p) => p.text || "")).join(" ").trim();

    if (isCodeEdit) {
      const updateMatch = replyText.match(/<GITHUB_UPDATE>([\s\S]*?)<\/GITHUB_UPDATE>/);
      if (updateMatch) {
        try {
          const rawJson = updateMatch[1]
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "");
          const parsed = JSON.parse(rawJson);

          if (parsed?.filePath && typeof parsed?.newContent === "string") {
            const cleanReply =
              replyText
                .replace(/<GITHUB_UPDATE>[\s\S]*?<\/GITHUB_UPDATE>/, "")
                .replace(/,\s*Hanzalah([.!?])/gi, "$1")
                .trim() || `I've prepared the update for ${parsed.filePath}. Tap Deploy below to push it live.`;

            const { audioDataUri, voiceSource } = await generateOrionAudio(cleanReply);
            return res.status(200).json({
              reply: cleanReply,
              audioDataUri,
              voiceSource,
              pendingAction: {
                type: "github_update",
                filePath: parsed.filePath,
                summaryOfChanges: parsed.summaryOfChanges || "Website update",
                commitMessage: parsed.commitMessage || `Update ${parsed.filePath}`,
                newContent: parsed.newContent
              }
            });
          }
        } catch (parseErr) {
          console.error("Failed to parse <GITHUB_UPDATE> block:", parseErr.message);
        }
      }
    }

    replyText = replyText
      .replace(/<GITHUB_UPDATE>[\s\S]*?<\/GITHUB_UPDATE>/g, "")
      .replace(/[*#`]/g, "")
      .replace(/,\s*Hanzalah([.!?])$/i, "$1")
      .trim() || "I'm online and ready.";

    const { audioDataUri, voiceSource } = await generateOrionAudio(replyText);

    return res.status(200).json({
      reply: replyText,
      audioDataUri,
      voiceSource
    });
  } catch (err) {
    return res.status(500).json({ error: `Server Error: ${err.message}` });
  }
}
