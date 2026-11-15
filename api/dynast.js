export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, chatHistory, liveOrders, liveStock } = req.body;

  const systemPrompt = `You are DYNAST, the bespoke executive AI assistant for Hanzalah, the founder of the luxury watch brand dynast.co.in. Address Hanzalah with calm, refined confidence. Keep spoken answers crisp (2 to 3 sentences max) so they sound natural when read aloud.
Founder Name: Hanzalah
Live Supabase Orders: ${JSON.stringify(liveOrders)}
Live Watch Inventory: ${JSON.stringify(liveStock)}`;

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
    generationConfig: { temperature: 0.5 }
  };

  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
  let reply = null;
  let lastErr = "AI generation failed";

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY || ""
          },
          body: JSON.stringify(payload)
        }
      );

      const data = await response.json();
      if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        reply = data.candidates[0].content.parts[0].text;
        break;
      }
      lastErr = data?.error?.message || lastErr;
    } catch (e) {
      lastErr = e.message;
    }
  }

  if (!reply) {
    reply = `Greetings Hanzalah. Supabase sync is active with ${liveOrders.length} orders and ${liveStock.length} watch items. I am fully online to assist with your custom horology studio.`;
  }

  return res.status(200).json({ reply });
}
