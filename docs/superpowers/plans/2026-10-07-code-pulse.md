# Code Pulse Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent implementation and review. Keep work in this new project directory.

**Goal:** 매일 공식 자료를 수집하는 한국어 변경 기록 사이트를 만들고 기존 VPC의 CloudFront, ALB, ECS Fargate 구조로 배포한다.

**Architecture:** 별도 수집 태스크가 공식 변경 기록과 연결된 공식 블로그를 읽고 Bedrock 해설을 S3에 저장한다. 읽기 전용 웹 서버가 React 화면과 피드를 제공한다.

**Tech Stack:** TypeScript, React, Vite, Fastify, AWS SDK v3, CDK, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-10-07-code-pulse-design.md

## Global Constraints

- 공식 자료만 사용한다.
- 한국어 서비스 문구와 생성 해설에 엠대시와 가운뎃점을 쓰지 않는다.
- 원문 발표일과 확인 시각을 구분한다.
- 기존 VPC vpc-0dfa5610180dfa628과 Prefix List pl-22a6434b를 사용한다.
- 매일 09:00 Asia/Seoul에 수집한다.
- 수집 범위는 2026-01-01부터 현재까지이며 시작일을 포함하고 미래 발표를 제외한다.
- 공식 제품 로고를 사용하고 초안과 윤문은 Claude Haiku 5.5로 작성한다.
- 새 프로젝트 폴더에만 코드를 작성한다. 기존 게임 사이트를 수정하지 않는다.

## Task 1: 수집과 저장

**Files:** src/shared/types.ts, src/collector/*, src/server/*, tests/collector.test.ts, tests/server.test.ts

**Interfaces:** Snapshot은 entries, sources, runs, generatedAt을 가진다. Entry는 공식 제목, 한국어 해설, 원문 URL, 발표일, 내용 해시, 확인 시각을 가진다. GET /api/feed는 Snapshot의 공개 데이터를 제공하고 GET /api/entries/:id는 상세를 제공한다.

- [x] 실제 공식 자료의 작은 fixture로 시험판 제외, Codex 항목 선별, Kiro 날짜 추출을 먼저 검증한다.
- [x] 수집기를 구현하고 자료 구조가 바뀌면 빈 결과를 성공으로 처리하지 않는다.
- [x] S3와 로컬 파일 저장소를 구현한다. 조건부 갱신의 충돌 재시도를 검증한다.
- [x] 근거를 검사하는 한국어 해설을 구현한다. 실패한 해설은 다음 실행에서 재시도한다.
- [x] 중복 실행, 부분 실패, 전체 실패, 원문 수정과 미래 날짜를 검증한다.
- [x] Fastify 읽기 API, 건강 확인과 정적 파일 제공을 구현한다.

검증 명령: `npm test -- tests/collector.test.ts tests/server.test.ts`

## Task 2: 읽기 화면

**Files:** index.html, src/client/*, public/*, tests/browser/*

**Interfaces:** src/shared/types.ts를 사용한다. GET /api/feed를 읽고 상세는 GET /api/entries/:id로 연다. 제품 ID는 claude-code, codex, kiro다.

- [x] 제품 필터, 날짜 탐색, 검색, 종류 필터와 저장한 글을 구현한다.
- [x] 상세 화면에 변화, 의미, 활용 방법, 공식 출처와 생성 해설 표시를 넣는다.
- [x] 로딩, 빈 결과, 수집 실패와 오래된 자료를 구별한다.
- [x] 모바일 화면, 키보드 탐색, URL 공유와 브라우저 저장을 검증한다.
- [x] human-ton 기준으로 한국어를 다듬는다.

검증 명령: `npm run build`와 `npm run test:browser`

## Task 3: AWS 인프라

**Files:** infra/*, cdk.json, Dockerfile, .dockerignore, tests/infra.test.ts

**Interfaces:** 컨테이너는 dist/server/index.js 또는 dist/collector/run.js를 실행한다. 포트는 8080, 건강 확인 경로는 /healthz다. DATA_BUCKET, AWS_REGION, BEDROCK_MODEL_ID, PUBLIC_BASE_URL 환경변수를 사용한다.

- [x] VPC 재사용, ALB Prefix List 제한, 기본 403과 전용 헤더, 프라이빗 ARM64 태스크를 CDK로 구현한다.
- [x] S3 권한을 웹 읽기와 수집 읽기/쓰기로 나눈다.
- [x] 일일 Scheduler, 실패 큐, 로그와 알람을 구현한다.
- [x] 템플릿 보안 검사와 도커 실행을 검증한다.

검증 명령: `npm run typecheck`, `npm test -- tests/infra.test.ts`, `npm run synth`

## Task 4: 통합, 검토와 배포

**Files:** docs/verification.md, docs/runbook.md, README.md, tools/*

- [x] 실제 공식 자료로 첫 피드를 만들고 제품별 해설과 출처를 검토한다.
- [x] 독립 코드 검토에서 확인된 문제를 수정한다.
- [x] AWS 스택을 배포하고 수집 태스크를 실행한다.
- [x] 공개 HTTPS, 정적 파일, API, 보안 그룹, Scheduler와 실패 상태를 확인한다.
- [x] 운영 명령, 비용 범위, 제한과 검증 결과를 기록한다.

## Task 5: 추가 요구 반영과 과거 기록

- [x] Claude Code 영문 changelog와 한국어 새 소식을 수집하고 같은 버전의 참고 자료를 합친다.
- [x] 페이지 안의 세 제품 표시를 공식 로고로 바꾸고 출처를 기록한다.
- [x] Haiku 5.5를 초안과 윤문, 실제 수집 환경과 권한에 적용하고 기존 해설도 갱신한다.
- [x] 2026-01-01부터 현재까지 공식 이전 페이지를 읽고 날짜 경계와 패치 중복을 검증한다.
- [x] 중단 후에도 과거 기록이 빠지지 않도록 저장하고 완료한 범위의 일일 재확인을 조절한다.
- [x] 확대된 실제 데이터로 해설과 날짜, 검색과 날짜 필터, 공개 로고와 수집 실행을 검증한다.

## Task 6: 방문 집계와 앱 버전

- [x] Robot Atlas의 집계 기준을 확인하고 현재 접속/누적 방문을 하단에 표시한다.
- [x] 전용 DynamoDB, 서명 쿠키와 두 탭 초기화 잠금으로 중복을 방지한다.
- [x] 실제 공개 API와 DynamoDB, 두 브라우저 탭으로 검증한다.
- [x] package.json 기준 앱 버전과 한국어 서비스 변경 기록을 표시한다.
- [x] CHANGELOG/릴리스 노트 동기화 명령, 빌드 검사와 향후 태그 릴리스 워크플로를 준비한다.
