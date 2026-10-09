# Code Pulse 운영

## 정적 사이트와 언어

정적 페이지 발행, 로컬 미리보기, 첫 S3 전환과 복구 절차는 [정적 배포 안내](static-delivery.md)에 있습니다. `SITE_BUCKET`이 설정된 수집 태스크는 최종 스냅샷 저장 후 정적 페이지와 두 언어의 목록을 갱신합니다. 정적 발행이 실패하면 실행 실패로 기록하며 이전 파일과 연결된 상세 내용은 남습니다. 개별 S3 파일은 원자적으로 교체하지만 사이트의 모든 파일이 동시에 바뀌는 것은 아닙니다.

스냅샷의 최근 수집 결과가 `success`여도 그 뒤의 정적 발행은 실패할 수 있습니다. 운영 완료는 태스크 종료 코드, `site_published`와 `collection_completed` 로그를 함께 확인해 판단합니다. 최신 전수 대조와 실제 자동 발행 결과는 [v1.3.0 검증 기록](verification.md#v130-정적-배포와-영어-지원)에 있습니다.

한국어는 Haiku 5.5 해설, 영어는 공식 원문에서 추출한 전체 항목입니다. 원문 항목 ID를 두 언어에서 유지하며 언어 전환으로 읽음 상태가 초기화되지 않습니다.

## 일일 수집

EventBridge Scheduler의 `code-pulse` 그룹에 등록된 일정이 매일 07:00 Asia/Seoul에 수집 태스크 한 개를 실행합니다. 일정과 태스크, 보안 그룹의 실제 이름은 `cdk-outputs.json`에 있습니다.

기본 수집 범위는 2026년 1월 1일부터 실행 시점까지입니다. 수집기는 공식 원문을 저장하고 내용이 달라진 항목에 해설을 만듭니다. 최대 세 개씩 해설을 생성하며 한국어를 다시 다듬은 뒤 근거 인용과 코드가 원문에 있는지 검사합니다. 중간 결과는 배치 처리가 끝난 뒤 조건부 S3 쓰기로 저장합니다. 완료 전에는 성공 실행 기록을 만들지 않습니다.

새 해설 생성은 실행 14분 뒤 중단하고 남은 항목을 준비 상태로 남깁니다. 전체 프로세스는 20분으로 제한합니다. 글이 준비 상태로 남으면 이후 수집에서 재시도합니다.

| 상태 | 의미 |
| --- | --- |
| `success` | 모든 출처를 확인했고 남은 해설 준비 항목이 없음 |
| `partial` | 일부 출처를 읽지 못했거나 해설이 남아 있음 |
| `failed` | 모든 출처를 읽지 못했거나 실행 자체가 실패함 |

원문 오류와 해설 오류를 구별합니다. 일부 출처가 실패해도 이전 글은 유지합니다. 정상 확인 후 발표가 없는 날을 오류로 표시하지 않습니다.

## 수동 실행

로컬 자료만 갱신하려면 `DATA_BUCKET`, `SITE_BUCKET`, `SITE_DIR`을 지정하지 않습니다. 일일 ECS 태스크에는 사이트 버킷이 설정돼 있어 수집 후 정적 발행도 수행합니다.

```bash
npm run collect -- --since 2026-01-01 --max-summaries 300
```

`--since`는 해당 날짜의 UTC 00:00부터 포함합니다. 최근 며칠만 확인하려면 `--days 45`를 사용하며 두 옵션은 함께 지정할 수 없습니다.

AWS 수집 도구는 `cdk-outputs.json`의 태스크와 네트워크 값을 읽습니다. 실제 계정도 확인하며 공인 IP를 비활성화합니다. AWS CLI가 설치돼 있어야 합니다.

```bash
node tools/run-worker.mjs --dry-run
node tools/run-worker.mjs --wait
```

`--dry-run`은 실행할 요청만 보여줍니다. `--wait`은 태스크를 시작하고 같은 ARN을 조회해 `STOPPED`와 컨테이너 종료 코드를 확인합니다. 수집 로그의 `collection_completed` 상태도 확인합니다. 관찰 시간이 초과돼도 새 태스크를 자동으로 시작하지 않습니다.

많은 과거 글을 채울 때는 `--max-summaries 300`을 지정할 수 있습니다. 한 번의 시간 제한은 그대로 적용되므로 실행이 끝난 뒤 남은 항목을 확인합니다.

```bash
node tools/run-worker.mjs --wait --since 2026-01-01 --max-summaries 300
```

최초 전체 수집은 Codex의 공식 이전 페이지를 많이 읽습니다. `--no-ai`로 원문을 먼저 저장한 뒤 해설을 채울 수 있습니다. Codex의 `historySince`가 최종 스냅샷에 저장된 이후에는 과거 기록을 유지하면서 최근 45일의 변경만 다시 읽습니다. 중간 저장만으로는 이 범위를 확정하지 않습니다.

GitHub HTML 요청은 2초 간격을 유지합니다. 서버가 Retry-After를 보내면 해당 대기 시간을 지키며, 60초보다 길면 출처 오류를 기록하고 이후 실행에서 다시 확인합니다.

## 로그와 알람

웹 로그와 수집 로그는 각각 CloudWatch Logs에 14일 보관합니다. 수집 로그의 주요 이벤트는 다음과 같습니다.

| 이벤트 | 확인할 내용 |
| --- | --- |
| `collection_started` | 실행 시작, 시작일 또는 최근 일수, 모델 ID |
| `entry_explained` | 해설을 만든 제품과 제목 |
| `entry_changes_progress` | 전체 목록의 제품, 버전, 준비한 항목 수와 원문 항목 수 |
| `explanation_pending` | 근거 검증이나 모델 호출 실패 |
| `site_published` | 두 언어의 정적 페이지와 목록 발행 결과 |
| `collection_completed` | 신규, 수정, 해설 수와 최종 상태 |
| `collection_failed` | 저장소나 실행 오류 |
| `collection_timeout` | 실행 시간 제한 |

`CodePulse` namespace의 `Application=code-pulse` 지표로 수집 성공과 실패를 확인합니다. 성공 누락 알람은 완료된 UTC 하루를 평가합니다. 첫 배포 직후에는 이전 하루의 성공 지표가 없으므로 ALARM일 수 있습니다.

Scheduler DLQ에는 태스크 시작 요청이 실패했을 때 메시지가 들어갑니다. 이미 시작한 태스크의 내부 오류는 수집 로그와 실패 지표에서 확인합니다. 지표를 남기기 전에 중단된 실행은 일일 성공 누락 알람으로 확인합니다.

알람은 계정에 생성되며 이메일이나 외부 메시지 발송 대상을 자동으로 등록하지 않습니다.

## 출처 구조 변경

출처별 `state`, `checkedAt`, `lastSuccessAt`, `error`를 확인합니다. 홈페이지가 정상이어도 문서 구조가 달라지면 파서가 실패할 수 있습니다.

1. 해당 공식 URL의 실제 응답을 확인합니다.
2. `src/collector/sources.ts`의 파서와 허용된 이동 경로를 수정합니다.
3. 바뀐 형식으로 회귀 테스트를 작성하고 관련 테스트를 실행합니다.
4. 다시 수집해 이전 글과 발표일이 유지되는지 확인합니다.

GitHub 릴리스 API에는 첨부 파일 메타데이터도 포함됩니다. 응답이 커져 수집 제한을 넘으면 페이지 크기와 실제 안정판 범위를 함께 확인합니다. 빈 응답을 정상 확인으로 처리해서는 안 됩니다.

## 해설 편집

짧은 개요와 전체 변경 목록은 따로 생성합니다. `--max-summaries`와 `--max-full-changes`는 각각 처리할 글 수이며 기본 80개, 허용 범위는 0~300개입니다. `--no-ai`에서는 두 생성 작업을 모두 실행하지 않습니다. 전체 목록이 미완성이면 짧은 개요가 준비돼 있어도 수집 결과는 `partial`입니다.

전체 목록은 원문 항목을 결정적으로 나누고, 각 ID에 한국어 설명이 정확히 하나 있는지 검사합니다. Haiku 5.5의 초안과 별도 윤문을 거친 묶음만 중간 저장합니다. 재실행은 같은 원문 해시와 모델, 형식에서 검증한 항목을 재사용합니다. 원문이 바뀌면 이전 목록을 현재 내용의 완성본으로 표시하지 않습니다.

`tools/polish-content.ts`는 기존 해설에 현재 human-ton 편집 기준을 적용합니다. 원문 발표일을 바꾸지 않으며 같은 내용 해시에만 편집을 적용합니다.

AWS에서 요약 모델을 바꿀 때는 환경변수뿐 아니라 `infra/lib/stack.ts`의 추론 프로필, foundation model ID와 호출 권한도 함께 갱신합니다.

현재 모델은 `global.anthropic.claude-haiku-5-5`입니다. 초안과 윤문에 같은 모델을 사용합니다. 배포 후 기존 글을 이 모델로 다시 작성하려면 다음 명령을 실행합니다.

```bash
node tools/run-worker.mjs --dry-run --refresh-model --max-summaries 300
node tools/run-worker.mjs --wait --refresh-model --max-summaries 300
```

대량 생성에서는 `--concurrency 6`을 추가할 수 있습니다. 기본 동시도는 3이며 최대 6까지 허용합니다. Haiku 5.5 호출은 초안과 윤문 모두 thinking을 비활성화하고 최대 출력 8,192토큰을 지정합니다. 이전 2,200토큰 설정은 추론 출력으로 한도가 소진되는 것을 실제 호출에서 확인했습니다.

`--refresh-model`은 저장된 해설의 모델 ID가 현재 설정과 다른 글만 갱신합니다. 수집 기간 밖의 기존 글도 포함합니다. 모델 호출이나 검증이 실패하면 기존 해설을 유지하며, 갱신할 글이 남으면 실행 상태는 `partial`입니다. 실행이 끝난 것을 확인한 뒤 같은 옵션으로 다시 실행하면 남은 글을 이어서 처리합니다. 일반 일일 실행에는 이 옵션을 사용하지 않습니다.

```bash
node --import tsx tools/polish-content.ts
```

특정 글을 직접 대조한 편집은 원문 해시와 함께 JSON으로 작성하고 적용할 수 있습니다. 원문이 바뀌었으면 적용을 중단합니다.

```bash
node --import tsx tools/apply-editorial.ts docs/initial-editorial.json
```

이 도구도 `DATA_BUCKET`을 지정하면 AWS 데이터를 갱신하므로 대상 저장소를 먼저 확인합니다. 운영 편집을 사이트에도 반영하려면 별도 `SITE_BUCKET`을 함께 지정하고, 현재 배포에 맞는 빌드를 `STATIC_DIR`로 선택합니다. `SITE_DIR`을 지정하면 로컬 정적 파일을 갱신합니다. `docs/initial-editorial.json`에는 초기 기록을 공식 원문과 직접 대조한 편집이 들어 있습니다.

전체 목록의 과거 이력을 처리할 때는 검증용 로컬 스냅샷 폴더를 명시합니다. 아래 도구는 `DATA_BUCKET`이 있어도 FileStore만 사용합니다. 실제 Bedrock 호출은 발생합니다. 로컬 이관의 동시도는 기본 3, 최대 12이며 일일 수집의 최대 6과 별개입니다.

```bash
node --import tsx tools/backfill-full-changes.ts --data-dir ./data/full-changes --concurrency 12
DATA_DIR=./data/full-changes node --import tsx tools/verify-full-changes.ts
```

진행 로그에는 ID와 개수, 상태만 기록합니다. `--entry <ID>`로 한 글을 지정하거나 `--max-entries <수>`로 이번 처리량을 제한할 수 있습니다. 전체 이관 완료는 선택한 일부 글의 성공이 아니라 전수 검증의 `pendingRecords: 0`과 정상 출처 확인으로 판단합니다. 검증 명령은 `configuredStore`를 사용하므로 로컬 확인 시 `DATA_BUCKET`은 지정하지 않습니다.

검토한 문구 교정은 `entryId`, `sourceHash`, 항목별 `id`와 `text`가 있는 JSON 배열로 작성합니다. 원문이 달라졌거나 항목이 없으면 적용을 중단합니다.

```bash
node --import tsx tools/apply-full-editorial.ts --data-dir ./data/full-changes --input docs/full-changes-editorial.json
node --import tsx tools/apply-full-editorial.ts --data-dir ./data/full-changes --input docs/full-changes-editorial.json --write
```

첫 명령은 미리보기이며 두 번째 명령이 로컬 파일을 갱신합니다. 발표일, 출처 확인 시각과 다른 항목은 보존합니다. 전체 목록의 모델과 원문 해시를 제외하는 API를 먼저 배포한 뒤 검증한 스냅샷을 조건부 병합으로 공개합니다.

전체 해설, 모델 ID, 날짜와 공식 출처를 점검하려면 `node --import tsx tools/verify-data.ts`를 실행합니다. 갱신 중인 상태를 조회할 때만 `--allow-pending`을 붙입니다.

별도 폴더에서 검증한 전체 백필은 `tools/publish-backfill.ts --input <폴더>`로 병합 결과를 먼저 확인합니다. `--write`를 붙이면 원문을 비공개 S3에 올린 뒤 조건부 쓰기로 스냅샷을 합칩니다. 공개 저장소의 더 최신 원문, 편집과 새 글을 보존합니다.

## 방문 집계

`GET /api/presence`는 집계를 읽고 서버 서명 쿠키를 준비합니다. 방문 수는 늘리지 않습니다. 화면이 보이는 동안 클라이언트가 30초마다 `POST /api/presence`로 활동을 확인합니다.

접속 수는 최근 90초의 쿠키 기준입니다. 영구 첫 방문 표식과 원자적 누적 증가로 같은 쿠키의 여러 탭과 재시작을 중복 계산하지 않습니다. 활성 항목에는 `expires_at` TTL을 적용하며 TTL 삭제가 늦어져도 조회 시각 조건으로 활성 수를 계산합니다.

운영에서는 DynamoDB와 Secrets Manager를 사용합니다. 집계를 읽지 못하면 화면은 마지막 확인 값이나 확인 불가 상태를 표시합니다. 웹 태스크에만 방문 테이블 권한이 있고 수집 태스크에는 없습니다.

## 버전 변경

기능을 추가한 다음 릴리스에서는 minor, 호환되는 수정은 patch, 비호환 변경은 major를 올립니다. `package.json`과 잠금 파일의 루트 버전을 함께 갱신하고 `src/shared/app-release.json`에 같은 버전의 변경 내용을 추가합니다.

`npm run release:sync`와 `npm run release:check`를 실행합니다. 버전 표시가 포함되므로 화면도 다시 빌드하고 앱 배포 후 사이트 버킷에 발행합니다. 문서만 동기화할 때는 버전을 올리지 않습니다. 저장소는 `whchoi98/code-pulse`, 기본 브랜치는 `main`입니다. `.github/workflows/release.yml`이 명시적으로 푸시한 `v<version>` 태그를 검사한 뒤 같은 릴리스 노트로 원격 릴리스를 만듭니다. 일반 브랜치 푸시는 릴리스를 공개하지 않습니다.

## 읽음 기록, 구독과 내보내기

읽음 상태는 `code-pulse-read:v1:` 접두사의 글별 localStorage 키에 저장합니다. 키에는 글 ID, 값에는 ID와 내용 변경 표식만 보관합니다. 원문과 해설 본문, 방문 쿠키는 읽음 기록에 저장하지 않습니다. 저장소를 쓸 수 없으면 현재 탭의 읽음 상태를 유지하며 안내를 표시합니다.

내용 변경 표식은 공개되는 글 내용과 원문 수정 시각을 기준으로 만듭니다. 출처 확인 시각과 편집 시각만 바뀌면 읽음 상태는 그대로입니다. 같은 글을 다시 요청하는 동안이나 요청이 실패했을 때는 이전 응답으로 읽음 처리하지 않습니다.

`GET /feed.xml`은 전체 최신 해설, `?product=<제품 ID>`는 해당 제품의 최신 해설을 최대 50개 반환합니다. `PUBLIC_BASE_URL`은 운영에서 HTTPS 루트 URL이어야 합니다. 배포에서는 `https://code-pulse.whchoi.net`을 주입합니다. 요청의 Host 헤더를 RSS 링크 생성에 사용하지 않습니다.

RSS는 게시물 API와 스냅샷 캐시를 공유하며 방문 집계에 쓰지 않습니다. `lang=en`을 지정하면 공식 영문 전체 항목을 제공합니다. 제품별 영어 구독은 `/feed.xml?product=kiro&lang=en`처럼 두 조건을 함께 사용합니다. 저장소 장애 시 이전 스냅샷이 있으면 캐시 금지 응답으로 제공하고, 처음부터 읽을 수 없으면 503을 반환합니다.

Markdown 내보내기는 현재 필터에 맞는 저장 글의 상세 내용을 모두 받은 뒤 브라우저에서 파일을 만듭니다. 한국어 해설 또는 공식 영문 항목 전체와 같은 언어의 글 주소를 담으며, 보관용 원문 필드와 내부 메타데이터는 제외합니다. 파일을 만드는 과정에서 서버 데이터를 바꾸거나 내보낸 파일을 외부 서비스로 보내지는 않습니다.

## Claude Code 문서

영문 공식 changelog는 버전과 발표일이 있는 릴리스를 제공합니다. 같은 버전의 GitHub 기록이 있으면 원문과 정확한 발표 시각은 GitHub 것을 유지하고 문서 링크를 추가합니다.

한국어 새 소식은 주간 버전 범위에 맞는 글에 연결합니다. 주간 요약 자체에는 발표일을 만들지 않습니다. 출처 화면에는 확인 시각만 표시하며, 해설을 생성할 때만 해당 주의 배경 자료를 전달합니다. 이 배경 본문은 공개 스냅샷과 API에 저장하지 않습니다.

## 배포와 복구

`npm run deploy`는 새 이미지를 만들고 ECS 서비스를 갱신합니다. 건강 확인 경로는 `/healthz`이며 실패한 서비스 배포는 ECS circuit breaker가 되돌립니다. 새 이미지 배포와 정적 사이트 발행을 모두 수행합니다. 앱 화면, `/content/ko/feed.json`, 영어 상세와 API를 확인한 뒤 배포 성공을 판단합니다.

공개 도메인은 `code-pulse.whchoi.net`입니다. DNS는 `dxdh24n4uucjz.cloudfront.net`을 가리키며, CloudFront의 대체 도메인에도 같은 이름을 등록합니다. TLS 인증서는 `us-east-1`의 발급된 `*.whchoi.net` 인증서를 재사용합니다. 인증서는 이 스택이 생성하거나 갱신하지 않습니다.

도메인과 인증서 ARN은 `infra/lib/stack.ts`에서 관리합니다. `PUBLIC_BASE_URL`, 웹의 `PUBLIC_ORIGIN`과 `SiteUrl` 출력도 같은 주소를 사용합니다. 기존 CloudFront 주소의 GET/HEAD 요청은 경로와 검색 조건을 보존해 새 도메인으로 308 이동합니다. 방문 POST는 이동시키지 않고 기존 Origin 검사로 처리합니다.

DNS를 연결한 뒤 CloudFront 403이나 TLS 연결 오류가 나면 DNS 대상, 대체 도메인의 철자, 인증서의 이름과 리전, 배포 완료 상태를 확인합니다. `code-pluse`처럼 철자가 다르면 DNS만 수정해도 해결되지 않습니다. 설정 변경 뒤에는 `node tools/verify-domain.mjs`, `node tools/verify-infrastructure.mjs`와 실제 HTTPS 화면, RSS와 방문 집계를 함께 확인합니다.

S3는 버전 관리를 사용합니다. 잘못된 편집이 공개됐다면 해당 객체의 이전 버전을 별도 경로에 내려받아 내용과 출처 시각을 확인한 뒤 복구합니다. 다른 수집 작업의 결과가 사라지지 않도록 조건부 쓰기나 점검된 편집 도구를 사용합니다.

스택은 기존 VPC, 서브넷, NAT와 라우트를 소유하지 않습니다. 스택을 삭제해도 데이터 및 사이트 버킷, 방문 집계 테이블, 원본 확인용 비밀과 방문 서명용 비밀, 로그와 DLQ는 보존합니다. 보존 리소스를 삭제하는 작업은 이 배포 절차에 포함하지 않습니다.

## 알려진 경계

정적 HTML과 목록의 CloudFront 캐시는 최대 60초이며 브라우저는 보이고 온라인인 동안 1분마다 목록을 확인합니다. 두 주기가 겹치면 열린 화면에 새 발행본이 반영되기까지 약 2분이 걸릴 수 있습니다. 호환 API와 RSS에는 별도의 웹 스냅샷 캐시 60초와 CloudFront 캐시 최대 60초가 적용됩니다. 출처의 마지막 성공 확인이 26시간을 넘거나 목록 갱신에 실패하면 화면에 최신성 안내를 표시합니다.

CloudFront에서 ALB까지는 HTTP를 사용합니다. 이 경로는 Prefix List와 전용 헤더로 제한하며, 사용자와 CloudFront 사이에는 HTTPS를 적용합니다.

실행 의존성은 `npm audit --omit=dev`로 검사합니다. 현재 잠금 파일의 CDK에는 개발 전용 `brace-expansion`의 알려진 취약점이 있으며 확인 당시의 버전과 결과는 README와 검증 기록에 있습니다. CDK 입력은 저장소에서 관리하는 설정과 파일 패턴이며 해당 패키지는 실행 이미지에 포함하지 않습니다. 공식 CDK의 수정 릴리스가 나오면 갱신합니다.
