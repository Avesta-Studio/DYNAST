import tls from "node:tls";
import crypto from "node:crypto";

function synthesizeOrionDeepVoice(rawText, timeoutMs = 2400) {
  return new Promise((resolve) => {
    const cleanSpeech = String(rawText || "")
      .replace(/[*#_`~>]/g, "")
      .replace(/\bDYNAST\b/gi, "Dynast")
      .replace(/https?:\/\/\S+/g, "")
      .trim()
      .slice(0, 500);

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
      try { socket.destroy(); } catch (e) {}
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
      } else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      }

      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        masked[i] = payload[i] ^ maskKey[i % 4];
      }
      sock.write(Buffer.concat([header, maskKey, masked]));
    }

    const socket = tls.connect(
      { host: "speech.platform.bing.com", port: 443, servername: "speech.platform.bing.com" },
      () => {
        const path = `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${connId}`;
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: speech.platform.bing.com`,
            `Upgrade: websocket`,
            `Connection: Upgrade`,
            `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36`,
            `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`,
            `Sec-WebSocket-Version: 13`,
            `Sec-WebSocket-Key: ${wsKey}`,
            `\r\n`
          ].join("\r\n")
        );
      }
    );

    socket.on("data", (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      if (!upgraded) {
        const headerEnd = rxBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        if (!rxBuffer.subarray(0, headerEnd).toString("utf8").includes("101")) return finish(null);
        rxBuffer = rxBuffer.subarray(headerEnd + 4);
        upgraded = true;

        sendWsTextFrame(
          socket,
          `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
        );
        // Tuned to match Orion's signature deep, resonant cadence
        sendWsTextFrame(
          socket,
          `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='en-US-AndrewMultilingualNeural'><prosody pitch='-5Hz' rate='+1%' volume='+25%'>${escapedText}</prosody></voice></speak>`
        );
      }

      while (rxBuffer.length >= 2) {
        const opcode = rxBuffer[0] & 0x0f;
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
        if (rxBuffer.length < offset + payloadLen) return;
        const frameData = rxBuffer.subarray(offset, offset + payloadLen);
        rxBuffer = rxBuffer.subarray(offset + payloadLen);

        if (opcode === 0x02 && frameData.length > 2) {
          const headerLen = frameData.readUInt16BE(0);
          const headerStr = frameData.subarray(2, 2 + headerLen).toString("utf8");
          if (headerStr.includes("Path:audio") && frameData.length > 2 + headerLen) {
            audioChunks.push(frameData.subarray(2 + headerLen));
          }
        } else if (opcode === 0x01 && frameData.toString("utf8").includes("Path:turn.end")) {
          return finish(audioChunks.length ? Buffer.concat(audioChunks).toString("base64") : null);
        } else if (opcode === 0x08) {
          return finish(audioChunks.length ? Buffer.concat(audioChunks).toString("base64") : null);
        }
      }
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(audioChunks.length ? Buffer.concat(audioChunks).toString("base64") : null));
  });
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { prompt = "", chatHistory = [], confirmAction = null, ttsOnly = false, ttsText = "" } = req.body || {};
  const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
  const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
  const GITHUB_REPO = "Avesta-Studio/DYNAST";

  if (ttsOnly && ttsText) {
    const audioBase64 = await synthesizeOrionDeepVoice(ttsText);
    return res.status(200).json({ audioBase64, mimeType: "audio/mpeg" });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel Environment Variables." });
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
          message: commitMessage || `DYNAST AI update to ${cleanPath}`,
          content: Buffer.from(newContent, "utf8").toString("base64"),
          sha: fileData.sha
        })
      });
      if (!putRes.ok) return res.status(500).json({ error: `GitHub Push Failed` });
      const replyMsg = `Done. The update to ${cleanPath} is now live on GitHub and deploying to dynast.co.in.`;
      const audioBase64 = await synthesizeOrionDeepVoice(replyMsg);
      return res.status(200).json({ reply: replyMsg, audioBase64, mimeType: "audio/mpeg" });
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

        const audioBase64 = await synthesizeOrionDeepVoice(replyText);
        return res.status(200).json({
          reply: replyText,
          audioBase64,
          mimeType: "audio/mpeg",
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
