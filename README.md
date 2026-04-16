# 상세페이지 설명 생성기

제품 사진 한 장으로 온라인 쇼핑몰 판매 글을 자동 생성합니다.
Gemini 3.0 Flash + Google 검색으로 활용법, 특징, 추천대상, 보관정보, 팩트체크 자동 생성.

## 배포 방법 (GitHub + Vercel, 약 15분)

### STEP 1 — Gemini API 키 발급 (무료)
1. https://aistudio.google.com/app/apikey 접속
2. Create API Key 클릭 → 키 복사

### STEP 2 — GitHub에 올리기
1. https://github.com 에서 New repository 생성 (이름: product-describer)
2. "upload an existing file" 클릭
3. 압축 해제한 폴더의 모든 파일 드래그 업로드
4. Commit changes 클릭

### STEP 3 — Vercel 배포
1. https://vercel.com 에서 GitHub 로그인
2. Add New Project → product-describer 선택 → Deploy (설정 변경 없이)

### STEP 4 — API 키 등록
1. Vercel 대시보드 → Settings → Environment Variables
2. Name: GEMINI_API_KEY / Value: (STEP 1 키 붙여넣기) → Save
3. Deployments 탭 → 최근 배포 → Redeploy

### STEP 5 — 공유
Vercel이 준 주소(예: https://product-describer-xxx.vercel.app)를
가족에게 카카오톡으로 공유하면 끝!

## 무료 사용 한도 (Gemini 3.0 Flash)
- 하루 1,500회 / 분당 15회 / 비용 $0
