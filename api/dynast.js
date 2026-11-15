export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, chatHistory, liveOrders, liveStock } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY environment variable is missing on Vercel." });
  }

  const systemPrompt = `You are DYNAST, the elite executive AI assistant for Hanzalah, the founder of the luxury watch brand dynast.co.in. 
You oversee the main store (dynast.co.in), the bespoke customization studio (dynast.co.in/bespoke), and administrative dashboards (dynast.co.in/admin & dynast.co.in/bespoke-admin).
Address Hanzalah with calm, refined confidence. Keep spoken answers crisp (2 to 3 sentences max) so they sound natural when read aloud.
Founder: Hanzalah
Live Orders: ${JSON.stringify(liveOrders)}
Live Inventory: ${JSON.stringify(liveStock)}`;

  const contents = [];
  if (Array.isArray(chatHistory)) {
    for (const h of chatHistory) {
      contents.push({
        role: h.role === 'Hanzalah' ? 'user' : 'model',
        parts: [{ text: h.text }]
      });
    }
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents,
    generationConfig: { temperature: 0.6 }
  };

  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
  let reply = null;
  let lastErr = "Unknown API error";

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify(payload)
        }
      );

      const data = await response.json();
      
      if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        reply = data.candidates[0].content.parts[0].text;
        break;
      } else {
        lastErr = data?.error?.message || JSON.stringify(data);
      }
    } catch (e) {
      lastErr = e.message;
    }
  }

  if (!reply) {
    return res.status(500).json({ error: "Gemini API Error: " + lastErr });
  }

  return res.status(200).json({ reply });
}
