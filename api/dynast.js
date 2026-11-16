import tls from "node:tls";
import crypto from "node:crypto";

// Direct 24kHz Conversational Male Neural Voice Synthesizer (Zero npm dependencies)
function synthesizeConversationalMaleVoice(rawText, timeoutMs = 3200) {
  return new Promise((resolve) => {
    const cleanSpeech = String(rawText || "")
      .replace(/[*#_`~>]/g, "")
      .replace(/\bDYNAST\b/gi, "Dynast")
      .replace(/https?:\/\/\S+/g, "")
      .trim()
      .slice(0, 550);

    if (!cleanSpeech) return resolve(null);

    const escapedText = cleanSpeech
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

    const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    let ticks = Math.floor(Date.now() / 1000) + 11644473600;
    ticks -= ticks % 300;
    const secMsGec = crypto
      .createHash("sha256")
      .update(`${ticks}0000000${TRUSTED_CLIENT_TOKEN}`, "ascii")
      .digest("hex")
      .toUpperCase();

    const connId = crypto.randomUUID().replace(/-/g, "");
    const reqId = crypto.randomUUID().replace(/-/g, "");
    const wsKey = crypto.randomBytes(16).toString("base64");

    let settled = false;
    const audioChunks = [];
    let rxBuffer = Buffer.alloc(0);
    let upgraded = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch (e) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(audioChunks.length ? Buffer.concat(audioChunks).toString("base64") : null);
    }, timeoutMs);

    function sendWsTextFrame(sock, text) {
      const payload = Buffer.from(text, "utf8");
      const len = payload.length;
      const maskKey = crypto.randomBytes(4);
      let header;

      if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }

      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        masked[i] = payload[i] ^ maskKey[i % 4];
      }
      sock.write(Buffer.concat([header, maskKey, masked]));
    }

    const socket = tls.connect(
      {
        host: "speech.platform.bing.com",
        port: 443,
        servername: "speech.platform.bing.com"
      },
      () => {
        const path = `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${connId}`;
        const upgradeHeaders = [
          `GET ${path} HTTP/1.1`,
          `Host: speech.platform.bing.com`,
          `Upgrade: websocket`,
          `Connection: Upgrade`,
          `Pragma: no-cache`,
          `Cache-Control: no-cache`,
          `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0`,
          `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`,
          `Sec-WebSocket-Version: 13`,
          `Sec-WebSocket-Key: ${wsKey}`,
          `\r\n`
        ].join("\r\n");
        socket.write(upgradeHeaders);
      }
    );

    socket.on("data", (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);

      if (!upgraded) {
        const headerEnd = rxBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const statusLine = rxBuffer.subarray(0, headerEnd).toString("utf8");
        if (!statusLine.includes("101")) {
          return finish(null);
        }
        rxBuffer = rxBuffer.subarray(headerEnd + 4);
        upgraded = true;

        const configMsg =
          `X-Timestamp:${new Date().toISOString()}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;

        // Locked onto en-US-BrianMultilingualNeural (Conversational Gemini-Live style male voice)
        const ssmlMsg =
          `X-RequestId:${reqId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${new Date().toISOString()}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice name='en-US-BrianMultilingualNeural'>` +
          `<prosody pitch='+0Hz' rate='+3%' volume='+10%'>${escapedText}</prosody>` +
          `</voice></speak>`;

        sendWsTextFrame(socket, configMsg);
        sendWsTextFrame(socket, ssmlMsg);
      }

      while (rxBuffer.length >= 2) {
        const opcode = rxBuffer[0] & 0x0f;
        const isMasked = (rxBuffer[1] & 0x80) !== 0;
        let payloadLen = rxBuffer[1] & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (rxBuffer.length < 4) return;
          payloadLen = rxBuffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (rxBuffer.length < 10) return;
          payloadLen = Number(rxBuffer.readBigUInt64BE(2));
          offset = 10;
        }

        if (isMasked) offset += 4;
        if (rxBuffer.length < offset + payloadLen) return;

        const frameData = rxBuffer.subarray(offset, offset + payloadLen);
        rxBuffer = rxBuffer.subarray(offset + payloadLen);

        if (opcode === 0x02 && frameData.length > 2) {
          const headerLen = frameData.readUInt16BE(0);
          const headerStr = frameData.subarray(2, 2 + headerLen).toString("utf8");
          if (headerStr.includes("Path:audio") && frameData.length > 2 + headerLen) {
            audioChunks.push(frameData.subarray(2 + headerLen));
          }
        } else if (opcode === 0x01) {
          const textStr = frameData.toString("utf8");
          if (textStr.includes("Path:turn.end")) {
            return finish(audioChunks.length ? Buffer.concat(audioChunks).toString("base64") : null);
          }
        } else if (opcode === 0x08) {
          return finish(audioChunks.length ? Buffer.concat(audioChunks).toString("base64") : null);
        }
      }
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => {
      finish(audioChunks.length ? Buffer.concat(audioChunks).toString("base64") : null);
    });
  });
}

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

  async function fetchFast(url, options = {}, timeoutMs = 1800) {
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
            message: commitMessage || `DYNAST AI update to ${cleanPath}`,
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

      const confirmReply = `Done. The update to ${cleanPath} is now live on GitHub and deploying to dynast.co.in.`;
      const audioBase64 = await synthesizeConversationalMaleVoice(confirmReply);
      return res.status(200).json({
        reply: confirmReply,
        audioBase64,
        mimeType: "audio/mpeg"
      });
    } catch (err) {
      return res.status(500).json({ error: "GitHub Update Error: " + err.message });
    }
  }

  // 2. SMART CONDITIONAL CONTEXT LOADING
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
        1400
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
                1100
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
      const res = await fetchFast(rssUrl, {}, 1100);
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
4. If asked to edit or update a website file, include the complete updated code at the very end wrapped in <GITHUB_UPDATE>{"filePath":"${targetFile || "index.html"}","summaryOfChanges":"...","commitMessage":"...","newContent":"..."}</GITHUB_UPDATE>.`;

  const contents = [];
  for (const h of chatHistory.slice(-8)) {
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

  const models = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"];
  let lastError = "";

  async function callModel(modelId, useGoogleSearchTool) {
    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: contents,
      generationConfig: { temperature: 0.55 }
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
      4500
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

            const audioBase64 = await synthesizeConversationalMaleVoice(cleanReply);
            return res.status(200).json({
              reply: cleanReply,
              audioBase64,
              mimeType: "audio/mpeg",
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

        // Synthesize the neural male voice in the exact same request so text & audio arrive together
        const audioBase64 = await synthesizeConversationalMaleVoice(allText);

        return res.status(200).json({
          reply: allText,
          audioBase64,
          mimeType: "audio/mpeg",
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
