# Complete changelog coverage

## English

The user requested every change, including fixes and smaller updates. Claude Code v2.1.293 has 56 official bullet items while the current page has three highlights. Keep the existing short overview and add a complete Korean list for every record across all three products, including stored history since 2026-01-01.

Extract source items deterministically without a count or character cutoff. Markdown bullets, their continuation lines and code fences remain together; narrative sources use complete paragraphs. Preserve section context and source order. Use stable content-derived IDs and reject empty extraction instead of claiming completion.

Store a separate `Entry.fullChanges` record. It contains source identity, generation version/model, source count, completion state and Korean items. Each extracted source ID must have exactly one reviewed Korean explanation. Haiku 5.5 processes bounded batches and polishes each batch. Never silently slice input, omit trailing items or expose the original source body. Missing or failed batches stay pending and can resume.

Public `fullChanges` omits sourceHash and model. The page shows all completed items with an honest count or pending status. Search, read-state fingerprints, Markdown exports and RSS also include the full list. Existing dates, IDs, short explanations, official links, visitor counts and custom domain stay compatible.

Migrate existing records in an isolated local store with progress checkpoints. Refresh official discovery for newly published records, preserve newer remote content on conditional publication, and verify v2.1.293 as 56/56. Verify the complete ID set for every migrated record, plus private-field exclusion, actual browser display and public deployment. A source fetch success or an old ready summary is not full coverage.

## 한국어

사용자는 주요 변화 외에 수정과 작은 변경도 모두 포함하도록 요청했습니다. Claude Code v2.1.293의 공식 항목은 56개이며 현재 주요 해설은 세 개입니다. 짧은 개요를 유지하고 세 제품의 모든 기록에 전체 한국어 목록을 추가합니다. 기존 2026-01-01 이후 이력도 처리합니다.

원문 항목은 개수나 글자 수로 자르지 않고 결정적으로 추출합니다. Markdown 목록의 이어지는 문장과 코드 블록은 함께 보관하고, 서술형 원문은 문단을 온전히 사용합니다. 절의 문맥과 원문 순서, 내용에서 만든 고정 ID를 보존합니다. 추출 결과가 없으면 완료로 처리하지 않습니다.

별도 `Entry.fullChanges`에 원문 식별 정보, 생성 버전과 모델, 원문 항목 수, 완료 상태와 한국어 항목을 보관합니다. 추출한 ID마다 검토한 설명이 정확히 하나 있어야 합니다. Haiku 5.5가 분할 처리와 윤문을 수행합니다. 입력을 조용히 자르거나 마지막 항목을 생략하지 않으며 원문 본문을 공개하지 않습니다. 실패한 부분은 준비 상태로 남겨 이어서 처리합니다.

공개 `fullChanges`에서는 sourceHash와 model을 제외합니다. 화면은 전체 항목과 정확한 개수 또는 준비 상태를 보여줍니다. 검색, 읽음 변경 표식, Markdown과 RSS에도 전체 목록을 포함합니다. 기존 날짜, ID, 짧은 해설, 공식 링크, 방문 집계와 도메인은 호환성을 유지합니다.

기존 기록은 별도 로컬 저장소에서 중간 저장하며 처리합니다. 새 발표를 확인하고 조건부 공개 병합에서 원격의 최신 내용을 보존합니다. v2.1.293의 56/56을 포함해 모든 기록의 항목 ID를 전수 대조하고 비공개 필드 제외, 실제 화면과 배포를 검증합니다. 출처 조회 성공이나 기존 짧은 해설 완료만으로 전체 포함을 판정하지 않습니다.
