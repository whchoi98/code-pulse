# 화면 구현 지시

작업 폴더는 /home/ec2-user/my-project/code-assistant-changelog 이다. 새 프로젝트이며 유효한 Git 저장소는 없다. 환경이 보호하는 .git를 수정하지 않는다.

docs/superpowers/specs/2026-10-07-code-pulse-design.md, docs/superpowers/plans/2026-10-07-code-pulse.md의 Task 2, src/shared/types.ts를 읽는다.

허용된 수정 범위는 index.html, src/client/**, public/**, tests/browser/**, playwright.config.ts, docs/frontend-report.md다. package.json, src/shared, collector, server, infra는 다른 작업자가 관리한다. 패키지가 필요하면 부모에게 요청한다. npm 설치가 현재 진행 중이다.

React, Vite, lucide-react를 사용한다. 한국어 독자를 위한 Code Pulse 화면을 완성한다. 프런트엔드 디자인 스킬과 human-ton 스킬을 읽고 적용한다. 한국어 문구에서 엠대시, 가운뎃점, 번역투와 과장을 제거한다. 짧지만 구체적인 표현을 쓴다. 제품명과 직접 인용은 보존한다.

API는 GET /api/feed로 Feed 타입을 반환한다. GET /api/entries/:id는 Entry를 반환한다. 스키마는 src/shared/types.ts에 있다. 제품 ID는 claude-code, codex, kiro다. 초기 테스트 fixture 이외에는 데이터를 꾸며 넣지 않는다. 실제 데이터는 부모가 연결한다.

완성할 기능:

1. 상단 제목과 수집 상태, 매일 오전 9시 한국 시간 확인 안내.
2. 제품별 필터와 실제 데이터로 만든 최근 7일 활동표.
3. 검색, 날짜 범위 또는 특정일, 변경 종류 필터, 저장한 글 보기.
4. 발표일 기준 최근 글 목록. 원문 날짜와 확인 시각을 혼동하지 않는다. 날짜 정밀도가 day이면 그대로 표시한다.
5. 상세 화면에서 한국어 설명, 왜 중요한지, 확인할 사항, 주요 변경의 근거와 공식 링크를 표시한다. 생성 해설에는 AI 해설임을 분명히 쓴다.
6. localStorage에 글 저장. 상세 링크 공유와 브라우저 뒤로 가기. 빈 결과, 로딩, API 실패, 출처 일부 실패, 자료가 오래된 상태를 구별한다.
7. 가벼운 출처 안내 화면 또는 dialog에서 공식 출처별 확인 시각과 상태를 표시한다.
8. 모바일, 키보드 초점, dialog focus와 Escape 닫기를 처리한다. reduced-motion과 라이트/다크 테마를 지원한다.

비주얼은 차분한 회청색 바탕과 남색 글자, 청록 강조다. 작은 제품별 활동표가 기억에 남는 요소다. 균일한 SaaS 통계 카드나 큰 장식 숫자로 시작하지 않는다. 본문 가독성, 여백, 날짜와 제품 표식의 질서를 다듬는다. 로고는 간단한 코드 기반 SVG 또는 글자 표식으로 만들고 공식 상표를 오인시키지 않는다.

브라우저 테스트를 작성한다. 필요하면 실제 API 대신 네트워크 fixture를 사용하되 검색, 필터, 저장, 상세, 오류, 390px 모바일에서의 수평 넘침과 키보드 동작을 검증한다. 스냅샷 문구 맞추기만 하는 테스트는 쓰지 않는다. 테스트 증거와 자체 검토 결과를 docs/frontend-report.md에 기록한다.

하위 에이전트는 생성하지 않는다. 완료 후 부모가 별도 검토를 요청한다. 변경 내용을 간단히 보고한다.
