# Code Pulse onboarding

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

### Prerequisites

Use Node.js 22 or newer and npm. The shell examples use Bash. Read [AGENTS.md](../AGENTS.md) and work from the project root.

Local file-backed browsing and fixture tests do not require AWS credentials. Official-source collection needs network access; AI generation additionally needs credentials for the configured Bedrock model. AWS deployment uses the AWS CLI, Docker with ARM64 build support and the existing account resources described in the [runbook](runbook.md).

### Run the built application

```bash
npm ci
npm run build
env -u DATA_BUCKET -u PRESENCE_TABLE -u PRESENCE_SECRET \
  NODE_ENV=development DATA_DIR=./data STATIC_DIR=./dist/public \
  PUBLIC_BASE_URL=http://localhost:8080 PUBLIC_ORIGIN=http://localhost:8080 \
  PORT=8080 npm start
```

Open `http://localhost:8080`. These settings use local files and in-memory visitor counts. Without `data/snapshot.json`, the server returns an empty feed and the UI shows the initial collection state. Local visitor counts reset when the server restarts. Stop the foreground server with Ctrl+C.

The application does not load `.env` files automatically. Set variables in the process environment. `DATA_BUCKET` selects S3 instead of `DATA_DIR`; `PRESENCE_TABLE` selects DynamoDB instead of the local visitor store. See the [README configuration table](../README.md#로컬-실행).

### Edit with Vite

Start the backend in one terminal:

```bash
env -u DATA_BUCKET -u PRESENCE_TABLE -u PRESENCE_SECRET \
  NODE_ENV=development DATA_DIR=./data \
  PUBLIC_BASE_URL=http://localhost:8080 PUBLIC_ORIGIN=http://localhost:5173 \
  PORT=8080 npm run dev
```

Start Vite in another terminal:

```bash
npm run dev:client -- --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://localhost:5173`. The explicit `PUBLIC_ORIGIN` allows this page's presence requests through the backend. [vite.config.ts](../vite.config.ts) proxies `/api` and `/healthz`, but not `/feed.xml`. Verify RSS using the built application at `http://localhost:8080`; the Vite RSS URL is not a subscription endpoint.

### Collect a small local sample

With Bedrock credentials available, this command reads recent official sources and generates at most three explanations:

```bash
env -u DATA_BUCKET DATA_DIR=./data AWS_REGION=ap-northeast-2 \
  npm run collect -- --days 7 --max-summaries 3 --max-full-changes 3
```

It writes local data and invokes `global.anthropic.claude-haiku-5-5` for drafting and polishing both the overview and the complete item list. The two limits count records, not individual changes. Existing records are retained. Add `--no-ai` to collect without model calls; explanations remain pending where missing. Exit code 2 means a partial run, including unfinished full lists, while 1 means failure. See the [runbook](runbook.md) for full history, retry and model-refresh procedures.

### Verify a change

| Scope | Commands |
| --- | --- |
| Version-bearing documents | `npm run release:check` |
| Types and implementation tests | `npm run typecheck`, `npm test` |
| One test file | `npm test -- tests/rss.test.ts` |
| Browser behavior | `npm run test:browser` |
| Build | `npm run build` |
| Infrastructure | `npm run synth -- --no-lookups` |

Install the browser once with `npx playwright install chromium` when required. Browser tests start a Vite server on port 4173 and use controlled API fixtures. Do not treat fixture results as live AWS verification.

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) when choosing checks. Documentation-only edits reuse applicable implementation results; verify their changed links and examples separately. [docs/verification.md](verification.md) records earlier deployments and their exact observations.

For pre-rendered HTML and complete English content, follow [local static publication](static-delivery.md#local-publication-and-preview). This also documents the two site environment variables and production deployment order.

## 한국어

### 준비 사항

Node.js 22 이상과 npm을 사용합니다. 셸 예제는 Bash 기준입니다. [AGENTS.md](../AGENTS.md)를 읽고 프로젝트 루트에서 작업합니다.

로컬 파일로 화면을 보거나 고정 자료를 사용하는 테스트를 실행할 때는 AWS 자격 증명이 필요 없습니다. 공식 자료 수집에는 네트워크가 필요하고, AI 해설 생성에는 설정한 Bedrock 모델의 호출 권한도 필요합니다. AWS 배포에는 AWS CLI, ARM64 이미지를 빌드할 수 있는 Docker와 [운영 안내](runbook.md)에 설명한 기존 계정 리소스를 사용합니다.

### 빌드한 앱 실행

```bash
npm ci
npm run build
env -u DATA_BUCKET -u PRESENCE_TABLE -u PRESENCE_SECRET \
  NODE_ENV=development DATA_DIR=./data STATIC_DIR=./dist/public \
  PUBLIC_BASE_URL=http://localhost:8080 PUBLIC_ORIGIN=http://localhost:8080 \
  PORT=8080 npm start
```

`http://localhost:8080`을 엽니다. 이 설정은 로컬 파일과 메모리 방문 집계를 사용합니다. `data/snapshot.json`이 없으면 서버는 빈 피드를 반환하고 화면에는 첫 수집을 기다리는 상태가 표시됩니다. 로컬 방문 집계는 서버를 다시 시작하면 초기화됩니다. 실행 중인 서버는 Ctrl+C로 종료합니다.

프로그램은 `.env` 파일을 자동으로 읽지 않습니다. 필요한 값을 프로세스 환경변수로 설정합니다. `DATA_BUCKET`을 지정하면 `DATA_DIR` 대신 S3를, `PRESENCE_TABLE`을 지정하면 로컬 방문 저장소 대신 DynamoDB를 사용합니다. 전체 변수는 [README의 환경 설정 표](../README.md#로컬-실행)에 있습니다.

### Vite로 화면 수정

터미널 하나에서 백엔드를 시작합니다.

```bash
env -u DATA_BUCKET -u PRESENCE_TABLE -u PRESENCE_SECRET \
  NODE_ENV=development DATA_DIR=./data \
  PUBLIC_BASE_URL=http://localhost:8080 PUBLIC_ORIGIN=http://localhost:5173 \
  PORT=8080 npm run dev
```

다른 터미널에서 Vite를 시작합니다.

```bash
npm run dev:client -- --host 127.0.0.1 --port 5173 --strictPort
```

`http://localhost:5173`을 엽니다. 위의 `PUBLIC_ORIGIN` 설정은 이 화면에서 보내는 방문 확인 요청을 허용합니다. [vite.config.ts](../vite.config.ts)는 `/api`와 `/healthz`를 프록시하지만 `/feed.xml`은 전달하지 않습니다. RSS는 `http://localhost:8080`의 빌드 화면에서 확인합니다. Vite의 RSS 주소는 구독용 엔드포인트가 아닙니다.

### 최근 자료를 로컬에 수집

Bedrock 자격 증명이 준비돼 있으면 다음 명령으로 최근 공식 자료를 읽고 해설을 최대 세 개 만듭니다.

```bash
env -u DATA_BUCKET DATA_DIR=./data AWS_REGION=ap-northeast-2 \
  npm run collect -- --days 7 --max-summaries 3 --max-full-changes 3
```

이 명령은 로컬 데이터를 갱신하고 개요와 전체 목록의 초안, 윤문에 `global.anthropic.claude-haiku-5-5`를 호출합니다. 두 한도는 개별 변경 항목 수가 아니라 글 수를 셉니다. 기존 기록은 유지합니다. 모델 호출 없이 수집하려면 `--no-ai`를 추가하며, 해설이 없는 글은 준비 상태로 남습니다. 종료 코드 2는 전체 목록 미완성 등을 포함한 부분 완료, 1은 실패입니다. 전체 기간 수집과 재시도, 모델 갱신은 [운영 안내](runbook.md)를 참고합니다.

### 변경 검증

| 범위 | 명령 |
| --- | --- |
| 버전이 들어 있는 문서 | `npm run release:check` |
| 타입과 구현 테스트 | `npm run typecheck`, `npm test` |
| 테스트 파일 하나 | `npm test -- tests/rss.test.ts` |
| 브라우저 동작 | `npm run test:browser` |
| 빌드 | `npm run build` |
| 인프라 | `npm run synth -- --no-lookups` |

브라우저 설치가 필요하면 `npx playwright install chromium`을 한 번 실행합니다. 브라우저 테스트는 4173번 포트의 Vite 서버와 정해진 API 응답 자료를 사용합니다. 이 결과를 실제 AWS 검증으로 취급하지 않습니다.

검사 범위는 [기여 안내](../CONTRIBUTING.md)에 따라 정합니다. 문서만 수정했다면 유효한 구현 검사 결과를 재사용하고, 바꾼 링크와 예제를 별도로 확인합니다. 이전 배포에서 확인한 결과는 [검증 기록](verification.md)에 있습니다.

정적 HTML과 전체 영문을 로컬에서 확인하려면 [정적 발행과 미리보기](static-delivery.md#로컬-발행과-미리보기)를 따릅니다. 사이트 환경변수와 운영 배포 순서도 같은 문서에 있습니다.
