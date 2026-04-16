import { useState, useRef, useCallback } from "react";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  이미지 자동 압축 (1280px 이하, JPEG 70%)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function compressImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let { width, height } = img;
      const MAX = 1280;
      if (width > MAX || height > MAX) {
        if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
        else { width = Math.round(width * MAX / height); height = MAX; }
      }
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const compressed = canvas.toDataURL("image/jpeg", 0.7);
      resolve({ base64: compressed.split(",")[1], mime: "image/jpeg" });
    };
    img.src = dataUrl;
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Gemini API 호출 (과부하 시 자동 재시도 3회)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function callGemini({ system, parts, useSearch = true }, retry = 3) {
  const body = {
    model: "gemini-2.5-flash",
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    ...(useSearch && { tools: [{ google_search: {} }] }),
  };

  const res = await fetch("/api/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("서버 응답 오류: " + text.slice(0, 120));
  }

  const errMsg = data.error?.message || data.error || "";

  // 과부하·503 오류면 4초 대기 후 자동 재시도
  if (!res.ok) {
    if (
      retry > 0 &&
      (errMsg.includes("high demand") ||
        errMsg.includes("overloaded") ||
        res.status === 503 ||
        res.status === 429)
    ) {
      await new Promise((r) => setTimeout(r, 4000));
      return callGemini({ system, parts, useSearch }, retry - 1);
    }
    throw new Error(errMsg || "API 오류");
  }

  const result = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text)
    .map((p) => p.text)
    .join("");

  if (!result) throw new Error("모델이 응답을 반환하지 않았습니다");
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  JSON 추출
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function extractJSON(raw) {
  const text = raw.replace(/```json|```/gi, "");
  const ai = text.indexOf("[");
  const oi = text.indexOf("{");
  const isArr = ai !== -1 && (oi === -1 || ai < oi);
  const open = isArr ? "[" : "{";
  const close = isArr ? "]" : "}";
  const start = text.indexOf(open);
  if (start === -1) throw new Error("응답에서 JSON을 찾지 못했습니다");
  let depth = 0, end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error("응답이 잘렸습니다. 다시 시도해주세요");
  return JSON.parse(text.slice(start, end + 1));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  프롬프트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PROMPT_GENERATE = `
당신은 온라인 쇼핑몰 상세페이지 전문 카피라이터입니다.
제품 사진(또는 힌트)을 보고 Google 검색으로 정보를 충분히 조사한 뒤
아래 JSON 형식으로만 응답하세요. 백틱/마크다운/부가 설명 절대 금지.

문체 규칙: 구술체 (~에요, ~거든요, ~답니다) — 소비자에게 직접 말하듯 친근하게.

{
  "productName": "정확한 제품명",
  "brand": "브랜드명",
  "category": "식품|음료|냉동식품|냉장식품|과자/스낵|건강식품|생활용품|화장품|기타",
  "oneLiner": "소비자 시선을 잡는 한 줄 카피 (20자 내외)",
  "usages": "이 제품으로 소비자가 직접 할 수 있는 구체적 행동을 구술체 2~3문장",
  "features": [
    { "title": "5자이내 특징명", "desc": "개인·가게 소비자가 누리는 실질 효용 1~2문장" }
  ],
  "recommendations": [
    "구체적 상황 묘사 (예: 바쁜 아침에 간편하게 식사를 해결하고 싶은 분)"
  ],
  "storage": {
    "type": "냉동|냉장|상온",
    "temperature": "보관 온도 (예: -18도 이하)",
    "afterOpen": "개봉 후 주의사항",
    "shelfLife": "유통기한 (예: 제조일로부터 12개월)"
  },
  "factClaims": [
    "팩트체크할 핵심 주장 — 수치·원산지·성분 등 검증 가능한 문장"
  ]
}

features 3~5개 | recommendations 3~5개 | factClaims 2~3개
`.trim();

const PROMPT_FACTCHECK = `
당신은 식품·상품 정보 팩트체커입니다.
아래 주장들을 Google 검색으로 각각 확인하고 JSON 배열로만 응답하세요.
백틱/마크다운/부가 설명 절대 금지.

[
  {
    "claim": "원래 주장 그대로",
    "status": "confirmed | uncertain | corrected",
    "note": "한 줄 결과 설명"
  }
]

confirmed: 검색으로 사실 확인 / uncertain: 확인 불가 / corrected: 틀렸음 → note에 올바른 내용
`.trim();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  색상 상수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CAT_COLOR = {
  식품: "#f97316", 음료: "#3b82f6", 냉동식품: "#06b6d4",
  냉장식품: "#10b981", "과자/스낵": "#f59e0b", 건강식품: "#84cc16",
  생활용품: "#8b5cf6", 화장품: "#ec4899", 기타: "#6b7280",
};
const ST_COLOR = { 냉동: "#06b6d4", 냉장: "#10b981", 상온: "#f97316" };
const FC_CFG = {
  confirmed: { c: "#10b981", bg: "#f0fdf4", bd: "#bbf7d0", icon: "✅", label: "사실 확인" },
  uncertain:  { c: "#f59e0b", bg: "#fffbeb", bd: "#fde68a", icon: "❓", label: "확인 불가" },
  corrected:  { c: "#ef4444", bg: "#fef2f2", bd: "#fecaca", icon: "⚠️", label: "정정 필요" },
};

function SecHeader({ icon, title, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8,
      marginBottom: 12, paddingBottom: 8, borderBottom: `2px solid ${color}22` }}>
      <span style={{ width: 26, height: 26, borderRadius: 7, background: `${color}1a`,
        color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>
        {icon}
      </span>
      <span style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{title}</span>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  메인 컴포넌트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [imgSrc,   setImgSrc]   = useState(null);
  const [imgB64,   setImgB64]   = useState(null);
  const [imgMime,  setImgMime]  = useState("image/jpeg");
  const [name,     setName]     = useState("");
  const [hints,    setHints]    = useState("");
  const [result,   setResult]   = useState(null);
  const [fc,       setFc]       = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [step,     setStep]     = useState("");
  const [err,      setErr]      = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [copied,   setCopied]   = useState(false);
  const fileRef = useRef();

  const loadFile = useCallback(async (file) => {
    if (!file?.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const { base64, mime } = await compressImage(dataUrl);
      setImgSrc(dataUrl);
      setImgB64(base64);
      setImgMime(mime);
      setResult(null); setFc(null); setErr(null);
    };
    reader.readAsDataURL(file);
  }, []);

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); loadFile(e.dataTransfer.files[0]); };

  const analyze = async () => {
    if (!imgB64 && !name.trim()) return;
    setLoading(true); setResult(null); setFc(null); setErr(null);

    const hintLines = [];
    if (name.trim())  hintLines.push(`제품명 힌트: ${name.trim()}`);
    if (hints.trim()) hintLines.push(`추가 특징: ${hints.trim()}`);
    const hintText = hintLines.length
      ? `\n\n[사용자 입력 힌트 — 반드시 반영]\n${hintLines.join("\n")}`
      : "";

    const parts = [];
    if (imgB64) parts.push({ inline_data: { mime_type: imgMime, data: imgB64 } });
    parts.push({ text: `이 제품을 Google 검색으로 충분히 조사한 뒤 JSON으로만 응답하세요.${hintText}` });

    try {
      setStep("🔍 Google 검색으로 제품 조사 중...");
      const raw1 = await callGemini({ system: PROMPT_GENERATE, parts, useSearch: true });
      const parsed = extractJSON(raw1);
      setResult(parsed);

      if (parsed.factClaims?.length) {
        setStep("✅ 팩트 체크 중...");
        const fcParts = [{ text: `제품명: ${parsed.productName}\n\n검증할 주장:\n${parsed.factClaims.join("\n")}` }];
        const raw2 = await callGemini({ system: PROMPT_FACTCHECK, parts: fcParts, useSearch: true });
        const fcArr = extractJSON(raw2);
        setFc(Array.isArray(fcArr) ? fcArr : []);
      }
    } catch (e) {
      setErr(e.message);
    }

    setLoading(false); setStep("");
  };

  const copy = () => {
    if (!result) return;
    const r = result;
    const lines = [
      `${r.productName}  (${r.brand})`, r.oneLiner, "",
      "【이렇게 활용해보세요】", r.usages, "",
      "【제품 특징】", ...(r.features ?? []).map((f) => `• ${f.title}: ${f.desc}`), "",
      "【이런 분들께 추천합니다】", ...(r.recommendations ?? []).map((v) => `• ${v}`), "",
      "【보관 & 유통기한】",
      `보관: ${r.storage?.type}  ${r.storage?.temperature}`,
      `유통기한: ${r.storage?.shelfLife}`,
      r.storage?.afterOpen ? `개봉 후: ${r.storage.afterOpen}` : null,
    ];
    if (fc?.length) {
      lines.push("", "【팩트체크】");
      fc.forEach((f) => lines.push(`${FC_CFG[f.status]?.icon} ${f.claim}  →  ${f.note}`));
    }
    navigator.clipboard.writeText(lines.filter((l) => l !== null).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const catColor = result ? (CAT_COLOR[result.category] ?? "#6b7280") : "#6b7280";
  const stColor  = result ? (ST_COLOR[result.storage?.type] ?? "#6b7280") : "#6b7280";
  const canRun   = (!!imgB64 || !!name.trim()) && !loading;

  return (
    <div style={{ minHeight: "100vh", fontFamily: "'Noto Sans KR', sans-serif",
      background: "linear-gradient(160deg,#fdf8f0 0%,#fef2ee 55%,#eef3ff 100%)",
      padding: "20px 16px 40px" }}>

      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes spin    { to { transform: rotate(360deg) } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(14px) } to { opacity:1; transform:translateY(0) } }
        @keyframes blink   { 0%,100% { opacity:1 } 50% { opacity:.35 } }
        input:focus, textarea:focus { border-color: #4285f4 !important; outline: none; }
      `}</style>

      {/* 헤더 */}
      <div style={{ maxWidth: 640, margin: "0 auto 20px",
        display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0,
          background: "linear-gradient(135deg,#4285f4,#34a853)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 20, boxShadow: "0 4px 16px rgba(66,133,244,.35)" }}>📸</div>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 900,
            color: "#1a1a2e", letterSpacing: "-.5px" }}>
            상세페이지 설명 생성기
          </h1>
          <p style={{ margin: 0, fontSize: 11, color: "#aaa" }}>
            사진 한 장 → 판매 글 자동 완성 + 팩트체크 · Gemini 2.5
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 640, margin: "0 auto" }}>

        {/* 이미지 업로드 */}
        <div
          onClick={() => fileRef.current?.click()}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          style={{
            border: `2px dashed ${(dragOver || imgSrc) ? "#4285f4" : "#ddd"}`,
            borderRadius: 16, cursor: "pointer", overflow: "hidden",
            background: dragOver ? "rgba(66,133,244,.04)" : "#fff",
            transition: "border-color .2s", marginBottom: 10,
            minHeight: 160, display: "flex", alignItems: "center",
            justifyContent: "center", position: "relative",
            boxShadow: "0 2px 12px rgba(0,0,0,.05)",
          }}>
          {imgSrc
            ? <img src={imgSrc} alt="제품"
                style={{ width: "100%", maxHeight: 280, objectFit: "contain", display: "block" }} />
            : <div style={{ textAlign: "center", padding: 28, color: "#ccc" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🖼️</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#777", marginBottom: 3 }}>
                  제품 사진을 드래그하거나 클릭하세요
                </div>
                <div style={{ fontSize: 11 }}>JPG · PNG · WEBP · 자동 압축</div>
              </div>
          }
          {imgSrc && (
            <div style={{ position: "absolute", top: 9, right: 9,
              background: "rgba(0,0,0,.45)", color: "#fff",
              borderRadius: 6, padding: "2px 9px", fontSize: 11, fontWeight: 600 }}>
              클릭해서 변경
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*"
          style={{ display: "none" }} onChange={(e) => loadFile(e.target.files[0])} />

        {/* 수동 입력 */}
        <div style={{ background: "#fff", borderRadius: 14, padding: "14px 16px",
          boxShadow: "0 2px 10px rgba(0,0,0,.05)", marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#777", marginBottom: 10 }}>
            📝 추가 정보{" "}
            <span style={{ fontWeight: 400, color: "#ccc" }}>(선택 · 더 정확해져요)</span>
          </div>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="제품명 (예: 비비고 왕교자 만두)"
            style={{ width: "100%", padding: "9px 12px", borderRadius: 8, boxSizing: "border-box",
              border: "1.5px solid #e8e8e8", fontSize: 13, color: "#333",
              fontFamily: "inherit", marginBottom: 9, transition: "border-color .2s" }} />
          <textarea
            value={hints} onChange={(e) => setHints(e.target.value)} rows={3}
            placeholder={"특징 메모 (줄바꿈 구분)\n예: 냉동제품 / 전자레인지 5분 / 14개입 700g"}
            style={{ width: "100%", padding: "9px 12px", borderRadius: 8, boxSizing: "border-box",
              border: "1.5px solid #e8e8e8", fontSize: 12, color: "#333", lineHeight: 1.65,
              fontFamily: "inherit", resize: "vertical", transition: "border-color .2s" }} />
        </div>

        {/* 생성 버튼 */}
        <button
          onClick={analyze} disabled={!canRun}
          style={{
            width: "100%", padding: "14px 0", borderRadius: 12, border: "none",
            background: canRun ? "linear-gradient(135deg,#4285f4,#34a853)" : "#e8e8e8",
            color: canRun ? "#fff" : "#bbb",
            fontSize: 15, fontWeight: 700, letterSpacing: "-.2px",
            cursor: canRun ? "pointer" : "not-allowed",
            boxShadow: canRun ? "0 4px 18px rgba(66,133,244,.35)" : "none",
            transition: "all .2s", marginBottom: 20,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
          {loading
            ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⏳</span>{step}</>
            : "✨ 상세페이지 설명 생성하기"}
        </button>

        {/* 에러 */}
        {err && (
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5",
            borderRadius: 10, padding: "12px 14px", color: "#dc2626",
            fontSize: 13, marginBottom: 16 }}>
            ⚠️ {err}
          </div>
        )}

        {/* 결과 카드 */}
        {result && (
          <div style={{ background: "#fff", borderRadius: 20,
            boxShadow: "0 8px 36px rgba(0,0,0,.09)",
            overflow: "hidden", animation: "fadeUp .4s ease", marginBottom: 24 }}>

            <div style={{
              background: `linear-gradient(135deg,${catColor}14,${catColor}26)`,
              borderBottom: `3px solid ${catColor}`,
              padding: "16px 18px",
              display: "flex", justifyContent: "space-between", alignItems: "flex-start",
            }}>
              <div>
                <span style={{ display: "inline-block", background: catColor, color: "#fff",
                  borderRadius: 5, padding: "1px 8px", fontSize: 10, fontWeight: 700,
                  marginBottom: 4 }}>{result.category}</span>
                <div style={{ fontSize: 10, color: "#aaa", marginBottom: 2 }}>{result.brand}</div>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 900, color: "#1a1a2e" }}>
                  {result.productName}
                </h2>
                <div style={{ marginTop: 5, fontSize: 13, fontWeight: 700, color: catColor }}>
                  {result.oneLiner}
                </div>
              </div>
              <button onClick={copy}
                style={{ background: copied ? "#10b981" : "#f3f4f6",
                  color: copied ? "#fff" : "#555", border: "none", borderRadius: 8,
                  padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  transition: "all .2s", whiteSpace: "nowrap", flexShrink: 0, marginLeft: 12 }}>
                {copied ? "✓ 복사됨" : "📋 복사"}
              </button>
            </div>

            <div style={{ padding: "18px 18px 20px" }}>

              <div style={{ marginBottom: 22 }}>
                <SecHeader icon="🛒" title="이렇게 활용해보세요" color="#f97316" />
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.9, color: "#374151",
                  wordBreak: "keep-all", background: "#fff7f0", borderRadius: 10,
                  padding: "12px 14px", borderLeft: "4px solid #f9731640" }}>
                  {result.usages}
                </p>
              </div>

              <div style={{ marginBottom: 22 }}>
                <SecHeader icon="⭐" title="제품 특징 & 소비자 효용" color={catColor} />
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(result.features ?? []).map((f, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start",
                      background: `${catColor}0a`, borderRadius: 10, padding: "10px 12px" }}>
                      <div style={{ minWidth: 60, background: catColor, color: "#fff",
                        borderRadius: 7, padding: "3px 6px", fontSize: 11, fontWeight: 700,
                        textAlign: "center", flexShrink: 0, lineHeight: 1.5 }}>{f.title}</div>
                      <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7 }}>{f.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 22 }}>
                <SecHeader icon="💡" title="이런 분들께 추천합니다" color="#8b5cf6" />
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {(result.recommendations ?? []).map((r, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start",
                      gap: 8, fontSize: 13, color: "#374151", lineHeight: 1.65 }}>
                      <span style={{ width: 18, height: 18, borderRadius: "50%",
                        background: "#8b5cf215", color: "#8b5cf6", fontSize: 10,
                        fontWeight: 900, flexShrink: 0, marginTop: 2,
                        display: "flex", alignItems: "center", justifyContent: "center" }}>✓</span>
                      {r}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: (loading || fc?.length) ? 22 : 0 }}>
                <SecHeader icon="📦" title="보관 방법 & 유통기한" color={stColor} />
                <div style={{ background: `${stColor}10`, borderRadius: 12,
                  padding: "13px 14px", border: `1px solid ${stColor}2e` }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr",
                    gap: 9, marginBottom: result.storage?.afterOpen ? 9 : 0 }}>
                    <div style={{ background: "#fff", borderRadius: 9, padding: "10px 12px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#bbb", marginBottom: 2 }}>보관 방법</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: stColor }}>{result.storage?.type}</div>
                      <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{result.storage?.temperature}</div>
                    </div>
                    <div style={{ background: "#fff", borderRadius: 9, padding: "10px 12px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#bbb", marginBottom: 2 }}>유통기한</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", lineHeight: 1.5 }}>{result.storage?.shelfLife}</div>
                    </div>
                  </div>
                  {result.storage?.afterOpen && (
                    <div style={{ background: "#fffbeb", borderRadius: 8,
                      padding: "8px 12px", fontSize: 12, color: "#92400e" }}>
                      ⚠️ 개봉 후: {result.storage.afterOpen}
                    </div>
                  )}
                </div>
              </div>

              {loading && step.includes("팩트") && !fc && (
                <div style={{ textAlign: "center", padding: "14px 0", color: "#999", fontSize: 13 }}>
                  <span style={{ animation: "blink 1.2s infinite", display: "inline-block", marginRight: 5 }}>🔍</span>
                  팩트 검증 중...
                </div>
              )}

              {fc?.length > 0 && (
                <div>
                  <SecHeader icon="🔍" title="자동 팩트체크 결과" color="#64748b" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {fc.map((item, i) => {
                      const cfg = FC_CFG[item.status] ?? FC_CFG.uncertain;
                      return (
                        <div key={i} style={{ background: cfg.bg, border: `1px solid ${cfg.bd}`,
                          borderRadius: 10, padding: "10px 13px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                            <span style={{ fontSize: 14 }}>{cfg.icon}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: cfg.c,
                              background: `${cfg.c}18`, borderRadius: 4, padding: "1px 7px" }}>{cfg.label}</span>
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 3 }}>{item.claim}</div>
                          <div style={{ fontSize: 12, color: "#6b7280" }}>{item.note}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            </div>
          </div>
        )}

        <div style={{ textAlign: "center", fontSize: 11, color: "#ccc" }}>
          Powered by Gemini 2.5 Flash · 상세페이지 설명 생성기
        </div>
      </div>
    </div>
  );
}
