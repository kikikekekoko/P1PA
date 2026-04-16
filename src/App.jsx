import { useState, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────
// Gemini API 호출 (프록시 경유)
// ─────────────────────────────────────────────────────────────
async function callGemini({ systemPrompt, imageParts = [], textPrompt }) {
  const body = {
    model: "gemini-3-flash-preview",
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [...imageParts, { text: textPrompt }],
      },
    ],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 4096,
    },
  };

  const res = await fetch("/api/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || JSON.stringify(data.error) || "API 오류");
  }

  // Gemini 응답에서 텍스트만 추출
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join("");
  if (!text) throw new Error("Gemini 응답이 비어있습니다. 다시 시도해주세요.");
  return text;
}

// ─────────────────────────────────────────────────────────────
// 응답 텍스트에서 JSON 블록 안전하게 추출
// ─────────────────────────────────────────────────────────────
function extractJSON(text) {
  // 마크다운 코드블록 제거
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

  // 배열인지 객체인지 판별해서 첫 번째 블록 추출
  const aIdx = clean.indexOf("[");
  const oIdx = clean.indexOf("{");
  const isArray = aIdx !== -1 && (oIdx === -1 || aIdx < oIdx);
  const open  = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";

  const start = clean.indexOf(open);
  if (start === -1) throw new Error("응답에서 JSON을 찾을 수 없습니다.");

  let depth = 0, end = -1;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === open)  depth++;
    if (clean[i] === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error("JSON이 잘렸습니다. 다시 시도해주세요.");

  return JSON.parse(clean.slice(start, end + 1));
}

// ─────────────────────────────────────────────────────────────
// 프롬프트
// ─────────────────────────────────────────────────────────────
const PROMPT_GENERATE = `당신은 온라인 쇼핑몰 상세페이지 전문 카피라이터입니다.
제품 사진과 힌트를 바탕으로 Google 검색으로 제품 정보를 충분히 조사한 뒤,
아래 JSON 형식으로만 응답하세요. (백틱·마크다운·설명 텍스트 없이 순수 JSON만)

문체: 구술체 (~에요, ~거든요, ~답니다, ~해보세요) — 소비자에게 말하듯 자연스럽게

{
  "productName": "정확한 제품명",
  "brand": "브랜드명",
  "category": "식품|음료|냉동식품|냉장식품|과자/스낵|건강식품|생활용품|화장품|기타",
  "oneLiner": "소비자 시선을 잡는 한 줄 카피 (20자 내외, 느낌표 활용)",
  "usages": "이 제품으로 소비자가 직접 할 수 있는 구체적 행동 2~3문장. 예: 버터 발라 간식으로도 좋고, 햄버거 번으로 써도 딱이에요!",
  "features": [
    { "title": "특징명(5자이내)", "desc": "개인·가게 소비자가 누리는 실질 효용 1~2문장" }
  ],
  "recommendations": [
    "이런 분께 추천 — 구체적 상황 묘사. 예: 바쁜 아침 간편하게 식사하고 싶은 분"
  ],
  "storage": {
    "type": "냉동|냉장|상온",
    "temperature": "예: -18℃ 이하",
    "afterOpen": "개봉 후 주의사항",
    "shelfLife": "예: 제조일로부터 12개월"
  },
  "factSources": [
    "팩트체크용 핵심 주장 — 수치·원산지·성분 등 검증 가능한 사실 문장"
  ]
}

features 3~5개, recommendations 3~5개, factSources 2~3개.`;

const PROMPT_FACTCHECK = `당신은 식품·상품 팩트체커입니다.
아래 주장들을 Google 검색으로 각각 확인하고, 순수 JSON 배열로만 응답하세요.
(백틱·설명 텍스트 없이)

[
  {
    "claim": "원래 주장 내용",
    "status": "confirmed|uncertain|corrected",
    "note": "한 줄 결과. confirmed=사실 확인, uncertain=확인 불가 이유, corrected=올바른 정보"
  }
]`;

// ─────────────────────────────────────────────────────────────
// 스타일 상수
// ─────────────────────────────────────────────────────────────
const CAT_COLOR = {
  "식품": "#f97316", "음료": "#3b82f6", "냉동식품": "#06b6d4",
  "냉장식품": "#10b981", "과자/스낵": "#f59e0b", "건강식품": "#84cc16",
  "생활용품": "#8b5cf6", "화장품": "#ec4899", "기타": "#6b7280",
};
const ST_COLOR = { "냉동": "#06b6d4", "냉장": "#10b981", "상온": "#f97316" };
const FC_CFG = {
  confirmed: { color: "#10b981", bg: "#f0fdf4", border: "#bbf7d0", icon: "✅", label: "사실 확인" },
  uncertain:  { color: "#f59e0b", bg: "#fffbeb", border: "#fde68a", icon: "❓", label: "확인 불가" },
  corrected:  { color: "#ef4444", bg: "#fef2f2", border: "#fecaca", icon: "⚠️", label: "정정 필요" },
};

// ─────────────────────────────────────────────────────────────
// 섹션 헤더
// ─────────────────────────────────────────────────────────────
function SectionHeader({ icon, title, color }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      marginBottom: 13, paddingBottom: 9,
      borderBottom: `2px solid ${color}28`,
    }}>
      <span style={{
        width: 27, height: 27, borderRadius: 8,
        background: `${color}20`, color,
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13,
      }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{title}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 메인 컴포넌트
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [image,          setImage]          = useState(null);
  const [imageBase64,    setImageBase64]    = useState(null);
  const [imageMime,      setImageMime]      = useState("image/jpeg");
  const [manualName,     setManualName]     = useState("");
  const [manualFeatures, setManualFeatures] = useState("");
  const [result,         setResult]         = useState(null);
  const [factChecks,     setFactChecks]     = useState(null);
  const [loading,        setLoading]        = useState(false);
  const [step,           setStep]           = useState("");
  const [error,          setError]          = useState(null);
  const [dragOver,       setDragOver]       = useState(false);
  const [copied,         setCopied]         = useState(false);
  const fileRef = useRef();

  // 파일 처리
  const processFile = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImage(e.target.result);
      setImageBase64(e.target.result.split(",")[1]);
      setImageMime(file.type);
      setResult(null); setFactChecks(null); setError(null);
    };
    reader.readAsDataURL(file);
  }, []);

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); processFile(e.dataTransfer.files[0]); };

  // 생성 실행
  const analyze = async () => {
    if (!imageBase64 && !manualName.trim()) return;
    setLoading(true); setResult(null); setFactChecks(null); setError(null);

    const hints = [];
    if (manualName.trim())     hints.push(`제품명 힌트: ${manualName.trim()}`);
    if (manualFeatures.trim()) hints.push(`추가 특징: ${manualFeatures.trim()}`);
    const hintStr = hints.length ? `\n\n[사용자 입력 힌트]\n${hints.join("\n")}` : "";

    const imageParts = imageBase64
      ? [{ inline_data: { mime_type: imageMime, data: imageBase64 } }]
      : [];

    try {
      // 1단계: 콘텐츠 생성
      setStep("🔍 Google 검색으로 제품 조사 중...");
      const raw1 = await callGemini({
        systemPrompt: PROMPT_GENERATE,
        imageParts,
        textPrompt: `이 제품을 Google 검색으로 충분히 조사하고 JSON으로만 응답하세요.${hintStr}`,
      });
      const parsed = extractJSON(raw1);
      setResult(parsed);

      // 2단계: 팩트체크
      if (parsed.factSources?.length) {
        setStep("✅ 팩트체크 중...");
        const raw2 = await callGemini({
          systemPrompt: PROMPT_FACTCHECK,
          imageParts: [],
          textPrompt: `제품명: ${parsed.productName}\n\n검증할 주장:\n${parsed.factSources.join("\n")}`,
        });
        const fc = extractJSON(raw2);
        setFactChecks(Array.isArray(fc) ? fc : []);
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false); setStep("");
  };

  // 복사
  const copyAll = () => {
    if (!result) return;
    const r = result;
    const lines = [
      `${r.productName} (${r.brand})`, r.oneLiner, "",
      "【이렇게 활용해보세요】", r.usages, "",
      "【제품 특징】", ...(r.features || []).map((f) => `• ${f.title}: ${f.desc}`), "",
      "【이런 분들께 추천합니다】", ...(r.recommendations || []).map((v) => `• ${v}`), "",
      "【보관 & 유통기한】",
      `보관: ${r.storage?.type} (${r.storage?.temperature})`,
      `유통기한: ${r.storage?.shelfLife}`,
      r.storage?.afterOpen ? `개봉 후 주의: ${r.storage.afterOpen}` : "",
    ];
    if (factChecks?.length) {
      lines.push("", "【팩트체크】");
      factChecks.forEach((f) => lines.push(`${FC_CFG[f.status]?.icon} ${f.claim} → ${f.note}`));
    }
    navigator.clipboard.writeText(lines.filter(Boolean).join("\n"));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const catColor = result ? (CAT_COLOR[result.category] || "#6b7280") : "#6b7280";
  const stColor  = result ? (ST_COLOR[result.storage?.type] || "#6b7280") : "#6b7280";
  const canGo    = (!!image || !!manualName.trim()) && !loading;

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(160deg, #fdf8f0 0%, #fef2ee 55%, #eef3ff 100%)",
      fontFamily: "'Noto Sans KR', sans-serif",
      padding: "20px 16px",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:.4} }
        input:focus, textarea:focus { border-color: #4285f4 !important; outline: none; }
        button:active { opacity: .85; }
      `}</style>

      {/* 헤더 */}
      <div style={{ maxWidth: 620, margin: "0 auto 18px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12,
          background: "linear-gradient(135deg, #4285f4, #34a853)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 20, boxShadow: "0 4px 14px rgba(66,133,244,.3)",
        }}>📸</div>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 900, color: "#1a1a2e", letterSpacing: "-.5px" }}>
            상세페이지 설명 생성기
          </h1>
          <p style={{ margin: 0, fontSize: 11, color: "#aaa" }}>
            사진 한 장 → 판매 글 완성 + 자동 팩트체크 · Gemini 3.0
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 620, margin: "0 auto" }}>

        {/* ── 이미지 업로드 ── */}
        <div
          onClick={() => fileRef.current?.click()}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          style={{
            border: `2px dashed ${dragOver || image ? "#4285f4" : "#ddd"}`,
            borderRadius: 16, background: dragOver ? "rgba(66,133,244,.04)" : "#fff",
            cursor: "pointer", transition: "all .2s", marginBottom: 10,
            minHeight: 150, display: "flex", alignItems: "center", justifyContent: "center",
            position: "relative", overflow: "hidden", boxShadow: "0 2px 10px rgba(0,0,0,.05)",
          }}
        >
          {image
            ? <img src={image} alt="제품" style={{ width: "100%", maxHeight: 260, objectFit: "contain" }} />
            : (
              <div style={{ textAlign: "center", padding: 28, color: "#ccc" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🖼️</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#777", marginBottom: 3 }}>
                  제품 사진을 드래그하거나 클릭하세요
                </div>
                <div style={{ fontSize: 11 }}>JPG · PNG · WEBP</div>
              </div>
            )
          }
          {image && (
            <div style={{
              position: "absolute", top: 8, right: 8,
              background: "rgba(0,0,0,.45)", color: "#fff",
              borderRadius: 6, padding: "2px 9px", fontSize: 10, fontWeight: 600,
            }}>클릭해서 변경</div>
          )}
        </div>
        <input
          ref={fileRef} type="file" accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => processFile(e.target.files[0])}
        />

        {/* ── 수동 입력 ── */}
        <div style={{
          background: "#fff", borderRadius: 14, padding: "14px 16px",
          boxShadow: "0 2px 10px rgba(0,0,0,.05)", marginBottom: 12,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#777", marginBottom: 10 }}>
            📝 추가 정보{" "}
            <span style={{ fontWeight: 400, color: "#ccc" }}>(선택 · 입력하면 더 정확해요)</span>
          </div>
          <input
            type="text" value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            placeholder="제품명 (예: 비비고 왕교자 만두 1.05kg)"
            style={{
              width: "100%", padding: "9px 12px", borderRadius: 8,
              border: "1.5px solid #e8e8e8", fontSize: 13,
              boxSizing: "border-box", marginBottom: 8,
              color: "#333", transition: "border-color .2s", fontFamily: "inherit",
            }}
          />
          <textarea
            value={manualFeatures}
            onChange={(e) => setManualFeatures(e.target.value)}
            placeholder={"특징 입력 (줄바꿈 구분)\n예:\n냉동 보관 필요\n전자레인지 5분 조리\n4인분 기준"}
            rows={3}
            style={{
              width: "100%", padding: "9px 12px", borderRadius: 8,
              border: "1.5px solid #e8e8e8", fontSize: 12,
              boxSizing: "border-box", resize: "vertical",
              color: "#333", lineHeight: 1.7,
              transition: "border-color .2s", fontFamily: "inherit",
            }}
          />
        </div>

        {/* ── 생성 버튼 ── */}
        <button
          onClick={analyze}
          disabled={!canGo}
          style={{
            width: "100%", padding: "14px 0", borderRadius: 12, border: "none",
            background: canGo ? "linear-gradient(135deg, #4285f4, #34a853)" : "#e8e8e8",
            color: canGo ? "#fff" : "#bbb",
            fontSize: 15, fontWeight: 700,
            cursor: canGo ? "pointer" : "not-allowed",
            boxShadow: canGo ? "0 4px 18px rgba(66,133,244,.35)" : "none",
            transition: "all .2s", marginBottom: 18,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          {loading
            ? <><span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⏳</span>{step}</>
            : "✨ 상세페이지 설명 생성하기"
          }
        </button>

        {/* ── 오류 ── */}
        {error && (
          <div style={{
            background: "#fef2f2", border: "1px solid #fca5a5",
            borderRadius: 10, padding: 14, color: "#dc2626",
            fontSize: 13, marginBottom: 16, lineHeight: 1.6,
          }}>
            ⚠️ {error}
          </div>
        )}

        {/* ── 결과 카드 ── */}
        {result && (
          <div style={{
            background: "#fff", borderRadius: 20,
            boxShadow: "0 8px 32px rgba(0,0,0,.09)",
            overflow: "hidden", animation: "fadeUp .4s ease",
            marginBottom: 24,
          }}>
            {/* 카드 헤더 */}
            <div style={{
              background: `linear-gradient(135deg, ${catColor}14, ${catColor}26)`,
              borderBottom: `3px solid ${catColor}`,
              padding: "16px 18px",
              display: "flex", justifyContent: "space-between", alignItems: "flex-start",
            }}>
              <div>
                <div style={{
                  display: "inline-block", background: catColor, color: "#fff",
                  borderRadius: 5, padding: "1px 8px", fontSize: 10, fontWeight: 700, marginBottom: 4,
                }}>{result.category}</div>
                <div style={{ fontSize: 10, color: "#bbb", marginBottom: 2 }}>{result.brand}</div>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 900, color: "#1a1a2e" }}>
                  {result.productName}
                </h2>
                <div style={{ marginTop: 5, fontSize: 13, fontWeight: 700, color: catColor }}>
                  {result.oneLiner}
                </div>
              </div>
              <button
                onClick={copyAll}
                style={{
                  background: copied ? "#10b981" : "#f3f4f6",
                  color: copied ? "#fff" : "#555",
                  border: "none", borderRadius: 8, padding: "6px 12px",
                  fontSize: 11, fontWeight: 600, cursor: "pointer",
                  transition: "all .2s", whiteSpace: "nowrap", flexShrink: 0, marginLeft: 12,
                }}
              >
                {copied ? "✓ 복사됨" : "📋 복사"}
              </button>
            </div>

            <div style={{ padding: 18 }}>

              {/* ① 활용법 */}
              <div style={{ marginBottom: 22 }}>
                <SectionHeader icon="🛒" title="이렇게 활용해보세요" color="#f97316" />
                <p style={{
                  margin: 0, fontSize: 14, lineHeight: 1.9, color: "#374151",
                  wordBreak: "keep-all", background: "#fff7f0", borderRadius: 10,
                  padding: "12px 14px", borderLeft: "4px solid #f9731648",
                }}>
                  {result.usages}
                </p>
              </div>

              {/* ② 특징 */}
              <div style={{ marginBottom: 22 }}>
                <SectionHeader icon="⭐" title="제품 특징 & 소비자 효용" color={catColor} />
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(result.features || []).map((f, i) => (
                    <div key={i} style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      background: `${catColor}09`, borderRadius: 10, padding: "10px 12px",
                    }}>
                      <div style={{
                        minWidth: 60, background: catColor, color: "#fff",
                        borderRadius: 6, padding: "3px 7px",
                        fontSize: 11, fontWeight: 700, textAlign: "center",
                        flexShrink: 0, lineHeight: 1.45,
                      }}>{f.title}</div>
                      <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7 }}>{f.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ③ 추천 */}
              <div style={{ marginBottom: 22 }}>
                <SectionHeader icon="💡" title="이런 분들께 추천합니다" color="#8b5cf6" />
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {(result.recommendations || []).map((rec, i) => (
                    <div key={i} style={{
                      display: "flex", alignItems: "flex-start", gap: 8,
                      fontSize: 13, color: "#374151", lineHeight: 1.7,
                    }}>
                      <span style={{
                        width: 19, height: 19, borderRadius: "50%",
                        background: "#8b5cf218", color: "#8b5cf6",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontWeight: 900, flexShrink: 0, marginTop: 2,
                      }}>✓</span>
                      {rec}
                    </div>
                  ))}
                </div>
              </div>

              {/* ④ 보관 */}
              <div style={{ marginBottom: factChecks?.length ? 22 : 0 }}>
                <SectionHeader icon="📦" title="보관 방법 & 유통기한" color={stColor} />
                <div style={{
                  background: `${stColor}0f`, borderRadius: 12,
                  padding: "13px 15px", border: `1px solid ${stColor}30`,
                }}>
                  <div style={{
                    display: "grid", gridTemplateColumns: "1fr 1fr",
                    gap: 9, marginBottom: result.storage?.afterOpen ? 9 : 0,
                  }}>
                    <div style={{ background: "#fff", borderRadius: 9, padding: "10px 12px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#bbb", marginBottom: 2 }}>보관 방법</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: stColor }}>{result.storage?.type}</div>
                      <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{result.storage?.temperature}</div>
                    </div>
                    <div style={{ background: "#fff", borderRadius: 9, padding: "10px 12px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#bbb", marginBottom: 2 }}>유통기한</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", lineHeight: 1.55 }}>
                        {result.storage?.shelfLife}
                      </div>
                    </div>
                  </div>
                  {result.storage?.afterOpen && (
                    <div style={{
                      background: "#fff8e1", borderRadius: 8,
                      padding: "8px 12px", fontSize: 12, color: "#92400e",
                    }}>
                      ⚠️ 개봉 후: {result.storage.afterOpen}
                    </div>
                  )}
                </div>
              </div>

              {/* ⑤ 팩트체크 로딩 */}
              {loading && step.includes("팩트") && !factChecks && (
                <div style={{ textAlign: "center", padding: "14px 0", color: "#999", fontSize: 13 }}>
                  <span style={{ animation: "pulse 1.2s infinite", display: "inline-block", marginRight: 5 }}>🔍</span>
                  팩트 검증 중...
                </div>
              )}

              {/* ⑤ 팩트체크 결과 */}
              {factChecks?.length > 0 && (
                <div>
                  <SectionHeader icon="🔍" title="자동 팩트체크 결과" color="#64748b" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {factChecks.map((fc, i) => {
                      const cfg = FC_CFG[fc.status] || FC_CFG.uncertain;
                      return (
                        <div key={i} style={{
                          background: cfg.bg, border: `1px solid ${cfg.border}`,
                          borderRadius: 10, padding: "10px 13px",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                            <span style={{ fontSize: 13 }}>{cfg.icon}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 700, color: cfg.color,
                              background: `${cfg.color}18`, borderRadius: 4, padding: "1px 6px",
                            }}>{cfg.label}</span>
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 3 }}>
                            {fc.claim}
                          </div>
                          <div style={{ fontSize: 12, color: "#6b7280" }}>{fc.note}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            </div>
          </div>
        )}

        <div style={{ textAlign: "center", fontSize: 11, color: "#ccc", paddingBottom: 20 }}>
          Powered by Gemini 3.0 · 상세페이지 설명 생성기
        </div>
      </div>
    </div>
  );
}
