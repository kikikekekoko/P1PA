/**
 * Vercel Serverless Function
 * POST /api/gemini
 *
 * 역할: GEMINI_API_KEY를 서버에서만 사용하고
 *       프론트엔드에 노출되지 않도록 프록시합니다.
 */
export default async function handler(req, res) {
  // CORS 헤더 (같은 도메인이라 필요 없지만 안전하게 추가)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.",
    });
  }

  // 프론트에서 model 필드를 body에 담아 보냄
  const { model, ...geminiBody } = req.body;
  const modelName = model || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
