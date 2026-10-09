# 배포 검증

## v1.3.0 정적 배포와 영어 지원

2026년 10월 9일 `code-pulse.whchoi.net`에 v1.3.0을 배포했다. 목록과 상세 HTML, 간결한 목록 데이터 및 전체 상세와 검색 파일을 비공개 S3에 만들고 CloudFront OAC로 제공한다. 방문 집계, RSS와 호환 API는 기존 ALB와 프라이빗 Fargate를 사용한다. 새 VPC나 NAT는 만들지 않았다.

소스는 `c73ab657d6e59663e4fe847365cf84b917a2955d` 커밋으로 `main`에 반영했다. GitHub Actions 실행 `37872098732`는 `2026-10-09T01:56:42Z`에 성공했으며 버전 일치, 타입, 테스트, 빌드와 실행 의존성 검사를 통과했다. 태그 전용 `publish-notes` 작업은 실행하지 않았다. 이는 해당 배포의 검증 기록이며 문서 동기화 과정에서 구현 검사를 새로 실행한 결과는 아니다.

| 항목 | 확인 결과 | 근거 |
| --- | --- | --- |
| 모든 버전의 전체 항목 | 616개 기록의 원문 항목 20,428개와 한국어 및 영어 항목 ID와 순서, 내용을 전수 대조. 준비 중 0개, 누락 0개 | [원문 검증](full-changes-v1.3.0-verification.json), [공개 정적 데이터 검증](static-content-verification.json) |
| 제품별 범위 | Claude Code 242개 기록과 6,809개 항목, Codex 201개와 11,443개, Kiro 173개와 2,176개. v2.1.293은 56개 전부 포함 | 같은 전수 검증 |
| 정적 페이지 | 두 언어 HTML 1,234개. 실제 홈페이지는 `Server: AmazonS3`, 초기 20개 글과 부팅용 목록을 포함 | [첫 발행](static-publication.json), [화면 검증](screenshots/bilingual-production/bilingual-report.json) |
| 자동 갱신 | 실제 수집 태스크가 success, 종료 코드 0으로 완료. 새 발행 generation 2, 변경 없는 상세와 자산 1,385개 재사용 | [수집과 발행 로그](static-collector-verification.json) |
| 수집 시각 | `cron(0 7 * * ? *)`, `Asia/Seoul`, ENABLED | [실제 인프라](static-infrastructure-verification.json) |
| 영어 화면 | 언어 전환, 공유와 RSS, 상세 항목, 버전 표시를 운영에서 확인. 한국어와 영어 모두 JavaScript 없이 v2.1.293의 56개 항목 표시 | [영어 및 정적 화면](screenshots/bilingual-production/bilingual-report.json) |
| 검색과 내보내기 | 전체 본문의 마지막 항목 검색, 저장 글 전체 Markdown, RSS 50개 글 각각의 전체 목록 및 모바일 검사 통과 | [운영 한국어 화면](screenshots/static-production/full-changes-report.json) |
| 캐시 | 운영에서 같은 상세를 다시 열 때 추가 상세 요청 0개. 화면 근처 요청 두 개 제한과 갱신, 오류, 읽음 상태는 브라우저 회귀로 확인 | [운영 캐시](screenshots/bilingual-production/bilingual-report.json), `tests/browser/demand-loading.spec.ts` |
| 보안과 가용성 | 두 버킷 비공개, AES256 및 버전 관리, OAC SigV4, 제어 기록 403, 기존 방문 권한 분리, GuardDuty와 정상 웹 대상 확인 | [실제 인프라](static-infrastructure-verification.json) |
| 구현 검증 | 최종 타입 검사와 단위/인프라 655개 통과. 전체 브라우저 97개와 이후 RSS를 포함한 언어 회귀 8개 통과. 빌드, CDK 합성과 별도 검토 통과 | [검토 기록](static-delivery-review.md) |

영어는 공식 원문에서 추출한 항목이며 영어 AI 해설로 표시하지 않는다. 한국어는 기존 Haiku 5.5 해설과 윤문을 유지한다. 내부 원문 필드, 원문 해시와 모델 식별자는 공개 정적 데이터에 넣지 않았다.

배포는 기존 화면을 유지한 준비 단계, 정적 파일 발행, S3 원본 전환 순서로 진행했다. 기존 도메인 리디렉션 함수를 바꾸지 않고 미리 준비한 정적 함수를 S3 원본과 함께 연결해 전환 중 잘못된 원본으로 재작성 주소가 전달되지 않게 했다. 준비 단계에서도 운영 HTTP 200을 확인했다.

### 같은 조건에서 측정한 로딩 시간

Pixel 7 화면, 다운로드 1.6Mbps와 지연 80ms, CPU 4배 제한 조건에서 세 번씩 측정한 중앙값이다. 각 측정은 새 브라우저 컨텍스트를 사용했으며 첫 글과 항목 수는 동일했다. CloudFront 엣지의 캐시 상태는 통제하지 않았다.

| 모바일 항목 | 이전 | v1.3.0 |
| --- | --- | --- |
| 목록 준비 | 10.64초 | 4.48초 |
| 첫 상세 열기 | 1.59초 | 0.38초 |
| 같은 상세 재열기 | 0.23초 | 0.44초 |

목록 준비는 약 58%, 첫 상세 열기는 약 76% 짧아졌다. 재열기의 전체 측정 시간은 더 길었으나 추가 상세 요청은 없었다. 클릭 측정에는 자동 스크롤과 클릭 가능 상태 대기, 렌더링이 포함되므로 이 수치를 네트워크 응답 시간으로 해석하지 않는다. 데스크톱 목록 준비는 346ms에서 247ms, 첫 상세는 148ms에서 78ms였다. [이전 측정](delivery-before.json), [배포 후 측정](delivery-after.json), [조건과 비교](delivery-comparison.json)를 함께 보관한다.

한국어 초기 목록 JSON은 6,469,112바이트에서 857,055바이트로 줄었다. 실제 초기 HTML은 이 목록과 첫 20개 글을 포함하며, 압축된 운영 응답은 약 217KB였다. 전체 본문을 없앤 것이 아니라 상세 파일과 필요할 때 읽는 전체 검색 색인으로 옮겼다.


최종 확인일은 2026년 10월 8일 UTC다. 공개 주소는 `https://code-pulse.whchoi.net`이며 앱 버전은 1.2.0이다.

## v1.2.0 전체 변경 사항

짧은 개요와 주요 변경 요약을 유지하고, 각 공식 원문의 모든 항목을 한국어 목록으로 추가했다. 오류 수정과 작은 개선도 포함한다. 원문 순서와 항목 ID를 보존하며, 긴 글을 개수나 글자 수로 자르지 않는다. 생성 중인 글은 전체 항목 수와 준비한 수를 표시한다.

| 항목 | 확인한 결과 | 근거 |
| --- | --- | --- |
| 전체 이력 | 613개 기록의 20,027개 항목 완료. Claude Code 241개 기록과 6,651개 항목, Codex 199개와 11,200개, Kiro 173개와 2,176개. 준비 중 0개 | `docs/full-changes-verification.json`, `docs/full-changes-data-verification.json` |
| Claude Code 2.1.293 | 보관한 공식 원문의 56개 목록을 ID와 순서까지 대조. 실제 화면과 저장한 Markdown, 전체 및 Claude Code RSS에서 56개 모두 확인 | `docs/full-changes-verification.json`, `docs/screenshots/full-production/full-changes-report.json` |
| 큰 목록과 검색 | Codex 0.156.0의 546개와 Kiro 1.0.52의 80개를 끝까지 표시. 짧은 개요와 처음 20개에 없는 검색어로 56번째 항목을 찾음 | `docs/screenshots/full-production/full-changes-report.json` |
| RSS와 내보내기 | 네 피드 각각 최신 50개 글을 제공하며 글 안의 전체 항목을 유지. 실제 저장 파일에 1번부터 56번까지 포함 | `docs/screenshots/full-production/full-changes-report.json`, `docs/screenshots/full-production/saved-export.md` |
| 공개 데이터 | API의 전체 목록에는 허용한 필드만 노출. 원문 본문과 전체 목록의 모델, 원문 해시는 공개하지 않음 | `tests/full-coverage.test.ts`, `docs/screenshots/full-production/full-changes-report.json` |
| 한국어 대조 | 2.1.293의 56개와 다른 제품 및 버전의 200개를 표본 검토. 8개 기록의 23개 교정을 원문 해시와 항목 ID에 맞춰 최종 생성 뒤 적용 | `docs/full-changes-content-review.json`, `docs/full-changes-editorial.json` |
| 기존 읽기 기능 | 읽음 상태 유지, 수동 읽지 않음 처리, 같은 제품의 이전과 다음 글, 검색 조건 복원과 저장 글 내보내기 통과 | `docs/screenshots/full-reading-production/reading-report.json` |
| 모바일 | 320px 다크 모드에서 56개와 마지막 항목을 확인. 화면 밖으로 나간 텍스트나 코드, 잘린 본문, 브라우저 오류 없음 | `docs/screenshots/full-production/full-changes-report.json` |
| 방문과 도메인 | 서명 쿠키의 반복 요청과 복원한 클라이언트에서 누적 방문 유지. 사용자 도메인 HTTPS와 기존 주소의 308 이동, 경로와 검색어 보존 | `docs/full-changes-presence-verification.json`, `docs/full-changes-domain-verification.json` |
| 코드와 배포 | 단위 및 인프라 테스트 595개, Chromium 테스트 77개, 타입 검사, 빌드, CDK 합성 통과. 스택 UPDATE_COMPLETE, CloudFront Deployed, 정상 웹 대상 1개 | `docs/full-changes-build-verification.json`, `docs/full-changes-infrastructure-verification.json` |

초안과 별도 한국어 윤문에는 모두 Claude Haiku 5.5를 사용했다. 복합 문장은 내부 부분으로 나누어 조건이 빠지지 않도록 처리한 뒤 원래 항목 ID로 합쳤다. 원문의 인라인 코드와 기술 식별자는 공백과 유니코드 표기까지 대조한다. 20,027개 전체에 대해 구조, ID, 코드와 원문 행의 보존을 검사했으며, 자연어 의미 전체를 사람이 전수 검토했다는 뜻은 아니다.

전체 이관은 명시적으로 선택한 로컬 FileStore에서 수행했다. 검증한 묶음마다 중간 저장하고 실패한 부분만 이어서 처리했다. 마지막 코드 표기 문제는 같은 검증을 적용한 개별 생성과 윤문으로 해결했다. 2026-10-08T10:52:33.745Z에 완료한 실제 공식 재수집은 여섯 출처가 모두 정상이며 신규, 수정과 추가 개요 생성은 0개였다.

모델과 원문 해시를 제외하는 새 API를 먼저 배포했다. 웹과 수집기 태스크 정의는 revision 4이며, 기존 VPC와 네트워크, 역할은 유지했다. 이후 2026-10-08T10:59:52.540Z에 원문을 비공개 보관하고 ETag 조건부 병합으로 613개 기록을 게시했다. 게시 직후 ETag는 `8e424501df40b625d1670215846d1ae7`이며, 당시 공개돼 있던 612개 기록을 모두 보존했다. 원문과 발표일의 최종 대조 결과는 `docs/full-changes-preservation.json`에 있다.

새 revision 4 수집 태스크 `00aa408c7604499d8f7736b95387fe8b`를 실제 실행했다. 11:02:02 UTC에 수집을 시작해 11:03:57 UTC에 success로 완료했고 컨테이너 종료 코드는 0이었다. 실행 중 GuardDuty를 확인했으며, 신규와 수정 기록, 추가 개요와 전체 목록 생성은 없었다. CollectionSuccess=1과 CollectionFailure=0이 기록됐다. 이후 S3의 613개 전체 목록과 원문, 발표일을 다시 대조해 변경이나 누락이 없음을 확인했다. 최종 객체 갱신 시각은 `2026-10-08T11:04:02Z`, ETag는 `653cb018358fe79d03aac215cdfd72fa`다. 근거는 `docs/full-changes-worker-verification.json`과 `docs/full-changes-preservation.json`에 있다.

실제 데이터 화면 검사에서 코드 배경 여백이 목록 안쪽 폭을 2px 넘은 사례를 발견했다. 문서와 본문은 320px였고 텍스트와 코드는 화면 안에 있었다. 검증 도구가 실제 텍스트와 코드 조각의 화면 경계를 확인하도록 보완했으며, 의도적으로 만든 가로 넘침은 계속 탐지한다. 이 보완으로 앱의 CSS나 코드 표기를 바꾸지 않았다.

`package.json`, 잠금 파일과 릴리스 문서를 1.2.0으로 동기화하고 이전 1.1.0과 1.0.0 기록을 유지했다. 실행 의존성 취약점은 0개다. 마지막 도구 보완에는 구문 검사와 실제 브라우저 검사를 새로 수행했고, 변경하지 않은 앱 코드의 단위 테스트와 빌드 결과는 재사용했다. Git 태그나 별도 원격 릴리스는 만들지 않았다.

## v1.1.0 배포와 도메인 확인

CloudFront의 대체 도메인에 등록된 `code-pluse.whchoi.net` 오타를 `code-pulse.whchoi.net`로 수정했다. DNS 대상은 올바른 배포를 가리키고 있었다. 기존 `us-east-1`의 발급된 `*.whchoi.net` 인증서를 연결했으며, 배포 코드에도 같은 도메인과 인증서를 반영했다.

| 항목 | 확인한 결과 | 근거 |
| --- | --- | --- |
| 사용자 도메인 | DNS CNAME 일치, 인증서 검증과 TLS 1.3 연결 성공, 홈페이지와 API, RSS, 건강 확인 모두 HTTPS 200 | `docs/domain-verification.json` |
| 기존 주소 | CloudFront 주소의 GET/HEAD가 새 주소로 308 이동. 경로, 한글 검색어와 중복 매개변수 값 보존 | `docs/domain-verification.json`, `docs/domain-function-verification.json` |
| 도메인 설정 | 정확한 별칭, TLS 정책, 여섯 캐시 동작의 함수 연결과 웹 Origin, 두 태스크의 기준 주소 일치 | `docs/infrastructure-verification.json` |
| 읽음 기록 | 브라우저 저장과 읽지 않은 글 필터, 수동 상태 변경, 내용 갱신과 확인 시각 구분, 실패한 요청의 읽음 처리 방지 | `tests/reading.test.ts`, `tests/browser/reading-tools.spec.ts`, `docs/screenshots/reading-production/reading-report.json` |
| 이전과 다음 글 | 같은 제품의 인접 발표 이동, 원래 검색 조건과 포커스, 스크롤 489px 복원 | `docs/screenshots/reading-production/adjacent-report.json` |
| RSS | 전체와 세 제품 피드 각각 최신 50개. 원문 발표일과 사용자 도메인 주소 유지, 주소 복사와 XML 검사 통과 | `tests/rss.test.ts`, `docs/screenshots/reading-production/reading-report.json` |
| Markdown | 현재 조건에 맞는 저장 글 전체 내보내기. 화면의 첫 20개 제한과 무관하며 공개 해설과 공식 링크 포함 | `tests/export.test.ts`, `tests/browser/reading-tools.spec.ts`, `docs/screenshots/reading-production/saved-export.md` |
| 방문 집계 | 새 도메인의 Secure/HttpOnly 쿠키 정상. 첫 방문 뒤 반복 요청 네 번과 복원한 클라이언트에서 누적 값 9 유지, 외부 Origin 차단 | `docs/presence-verification.json` |
| 기존 화면 | 612개 기록, 여섯 정상 출처, 1월 기록 48개, 공식 로고, 검색과 저장, 모바일과 다크 모드, v1.1.0 표시 확인. 브라우저 오류 0 | `docs/screenshots/production-v1.1.0/browser-report.json` |
| 코드와 배포 | 단위와 인프라 346개, 브라우저 63개, 타입 검사, 빌드와 CDK 합성 통과. 스택 UPDATE_COMPLETE, CloudFront Deployed, 정상 웹 대상 1개와 GuardDuty 확인 | 실행 기록, `docs/infrastructure-verification.json` |

읽음 기록과 저장 글은 브라우저의 도메인별 저장소에 보관한다. RSS는 서버에서 준비된 해설을 읽고, Markdown 파일은 브라우저에서 만든다. 원문 전체나 내부 모델 식별자, 방문 쿠키를 RSS와 내보내기 파일에 넣지 않는다.

`package.json`, 잠금 파일, 화면의 버전과 `src/shared/app-release.json`은 1.1.0으로 일치한다. `release:sync`로 CHANGELOG와 릴리스 노트를 갱신하고 빌드와 배포 전 `release:check`를 통과했다. 기존 1.0.0 기록은 보존했다. 이 폴더에는 유효한 Git 저장소가 없어 원격 태그나 GitHub 릴리스는 게시하지 않았다.

배포 후 S3 스냅샷의 최종 갱신 시각은 `2026-10-08T00:22:53Z`, ETag는 `ea6cab76b9f409a201d107b676c9e9f8`로 확인했다. 이번 작업에서는 수집기와 AI 생성 작업을 다시 실행하지 않았다. 새 웹과 수집 태스크 정의는 revision 3이며 매일 09:00 Asia/Seoul 일정은 새 수집 정의를 참조한다.

컨테이너 빌드의 실행 의존성 취약점은 0개다. 개발용 CDK 번들의 기존 취약점 한 건은 README에 기록한 상태다. cdk-nag는 Compliant 31개와 리소스별 Suppressed 16개이며 미해결 항목은 없다.

## v1.0.0 반영 상태

아래는 2026년 10월 8일 초기 기능 완료 당시의 기록이다. 당시 공개 주소는 `https://dxdh24n4uucjz.cloudfront.net`이었다.

| 항목 | 확인한 결과 | 근거 |
| --- | --- | --- |
| 요청 기간 | 2026-01-01부터 현재까지 수집. 실제 첫 발표는 1월 6일, 마지막 발표는 10월 7일 | `docs/data-verification.json` |
| 전체 기록 | 612개. Claude Code 240, Codex 199, Kiro 173. 1월 기록 48개 | `docs/year-history-verification.json`, `docs/data-verification.json` |
| 해설 | 612개 모두 Haiku 5.5, human-ton-1, 준비 중 0, 형식과 근거 오류 0 | `docs/backfill-data-verification.json` |
| 내용 대조 | 중요 변경 등 68개를 추가 대조하고 root의 1개 수정을 더해 33개 편집 반영 | `docs/backfill-content-review.json`, `docs/backfill-editorial.json` |
| 공식 출처 | 여섯 출처 정상. Claude Code 영문 changelog와 한국어 주간 자료 포함. 주간 범위로 발표일을 만들지 않음 | `src/collector/sources.ts`, `docs/data-verification.json` |
| 공식 로고 | 제품 필터, 활동표, 목록, 상세와 출처에 세 제품의 공식 이미지 표시 | `public/brand/SOURCES.md`, `docs/screenshots/production/browser-report.json` |
| 방문 집계 | DynamoDB 저장, 서명 쿠키, 90초 활성과 영구 누적. 반복/복원한 클라이언트에서 누적 유지 | `docs/presence-verification.json` |
| 최초 두 탭 | 같은 실제 브라우저의 두 탭에서 방문 쿠키 하나 발급 | `docs/visitor-browser-verification.json` |
| 버전과 변경 기록 | package.json의 1.0.0을 하단 표시. CHANGELOG/릴리스 노트 생성과 빌드 전 일치 검사 | `tools/release-docs.mjs`, `docs/versioning.md` |
| AWS 구조 | 기존 VPC, CloudFront Prefix List, ALB와 프라이빗 Fargate 유지. GuardDuty 정상 | `docs/infrastructure-verification.json` |
| 실제 화면 | 공개 HTTPS에서 612개, 여섯 출처, 1월 필터, 검색, 저장, 상세, 모바일, 다크 모드, 방문/버전 검사 통과 | `docs/screenshots/production/browser-report.json` |
| 코드 검증 | 단위/인프라 256개, 브라우저 47개, 타입 검사와 빌드 통과 | 실행 기록, `docs/frontend-report.md` |

## 수집과 공개 데이터 반영

전체 원문은 공식 응답을 보관해 검증했다. Claude Code GitHub 3페이지와 영문 문서, Codex GitHub 목록 88페이지와 잘린 본문 29개, Kiro 목록 14페이지를 읽었다. Kiro는 부모 글이 오래됐어도 최근 패치가 있을 수 있어 마지막 페이지까지 확인한다. Codex의 Python SDK는 CLI와 구별해 제품 기록으로 표시한다.

612개 해설의 초기 생성은 별도 로컬 데이터 폴더에서 Bedrock Haiku 5.5로 수행했다. 이전 2,200토큰 설정이 추론 출력으로 한도를 소진하는 것을 진단 호출로 확인했다. thinking을 비활성화하고 최대 출력 8,192토큰을 지정한 초안과 윤문 호출은 모두 end_turn으로 끝났다. 검증에 실패한 초안은 공개하지 않았다.

검토가 끝난 자료는 원문을 비공개 S3에 보관한 뒤 ETag 조건부 병합으로 공개 스냅샷에 반영했다. 기존 공개 글과 실제 실행 기록, 더 최신인 원문과 편집을 보존했다. `docs/backfill-publication.json`에 게시 결과가 있다.

매일 09:00 Asia/Seoul 일정은 활성화돼 있다. 10월 8일 정기 태스크 `4143c05aa8ca4915a0d982eb808c5bc9`에서 TaskDefinition:2, GuardDuty RUNNING과 실제 Haiku 5.5 해설 80개 생성을 확인했다. 한 번의 생성 한도 때문에 이 최초 대량 실행은 partial/종료 코드 2로 끝났다. 최종 스냅샷 반영 뒤 같은 대상의 일회성 일정이 태스크 `82a1f7493cee4aefb3f5244702ade86c`를 시작했다. 00:21:18 UTC에 수집을 시작해 00:22:52 UTC에 success로 완료했고 컨테이너 종료 코드는 0이었다. GuardDuty도 실행 중인 상태를 확인한 뒤 종료 코드 0을 확인했다. CollectionSuccess=1과 CollectionFailure=0이 기록됐고, 검증 일정은 자동 삭제됐다. 현재는 일일 일정만 ENABLED로 남아 있다. 00:24 UTC 최종 데이터 검사에서도 612개 모두 ready, Haiku 5.5, 오류 0을 확인했다.

중복 초기 수집을 중단하려던 요청은 자동 승인 검토에서 거부됐다. 명시적 중단 승인 부재와 진행 중인 수집 손실 위험이 이유였다. 요청은 실행되지 않았으며 우회하지 않고 태스크의 정상 종료를 기다렸다.

## 방문과 버전 운영

방문 데이터는 `CodePulse-PresenceTable3ADAA3E7-DODDVNJWV4YM`에 별도로 저장한다. 웹 역할은 이 테이블의 GetItem, PutItem, UpdateItem, Query만 허용하고 수집 역할에는 DynamoDB 권한을 주지 않는다. `/api/presence`만 캐시를 끄고 쿠키와 Origin을 전달한다. 기존 게시물 API는 GET/HEAD 전용이다.

서버가 발급한 HttpOnly 서명 쿠키를 사용하며 IP나 브라우저 지문을 저장하지 않는다. 최초 GET과 첫 POST는 브라우저의 탭 간 잠금으로 직렬화한다. 잠금을 지원하지 않는 환경에서는 쿠키를 저장하거나 방문을 기록하지 않고 집계를 읽는다.

당시 버전은 package.json의 1.0.0이었다. 새 기능, 수정과 비호환 변경의 버전 정책을 AGENTS.md에 기록했다. `release:sync`와 `release:check`가 화면 기준 버전, 잠금 파일, CHANGELOG와 릴리스 노트를 맞춘다. Git 저장소가 연결되면 명시적으로 푸시한 태그에 대해 릴리스 워크플로가 같은 노트를 사용한다. 현재 폴더에는 유효한 Git 저장소가 없어 원격 릴리스를 만들거나 실행했다고 주장하지 않는다.

실행 의존성 보안 검사 결과는 0개다. 개발 전용 CDK 번들의 알려진 취약점 한 건은 이전 기록과 README에 남겼다. 첫 갱신 이미지 빌드에서 새 버전 검사 파일의 COPY 누락을 발견해 Dockerfile을 보완했으며, 이후 배포는 성공했다.

## 최초 배포 기록

아래는 2026년 10월 7일의 초기 75개 자료와 네 출처 기준 기록이다. 최신 상태는 위의 최종 반영 상태와 연결한 JSON 보고서를 기준으로 한다.

검증일은 2026년 10월 7일 UTC다. 공개 주소는 `https://dxdh24n4uucjz.cloudfront.net`이다.

## 요구 사항과 근거

| 요구 사항 | 확인한 결과 | 근거 |
| --- | --- | --- |
| 세 제품의 공식 변경 기록 | Claude Code, Codex, Kiro의 중복 없는 기록 75개. 공식 수집 경로 네 곳 모두 정상 | `docs/data-verification.json`, `src/collector/sources.ts` |
| 기능과 의미 소개 | 모든 글에 한국어 해설 제공. 형식, 근거 인용, 금지 기호 검사 통과 | `docs/data-verification.json`, `src/collector/explanation.ts` |
| 한국어 윤문 | human-ton 기준의 별도 편집 단계 적용. 적용 범위와 세부 정보가 모호한 초기 자료는 원문과 직접 대조해 수정 | `docs/initial-editorial.json` |
| 매일 확인 | `code-pulse-daily`, `cron(0 9 * * ? *)`, `Asia/Seoul`, `ENABLED`, 유연한 시간 창 OFF | `docs/infrastructure-verification.json` |
| 실제 자동 실행 | 같은 실행 역할과 대상을 사용하는 일회성 일정이 실제 태스크를 시작함. 수집 컨테이너 종료 코드 0 | `docs/scheduler-verification.json` |
| 실제 해설 생성과 저장 | 실제 공식 릴리스 한 건의 해설을 Fargate에서 생성하고 S3에 저장. 실행 상태 success, 실패 출처 없음 | 수집 로그와 `docs/data-verification.json` |
| 기존 VPC 사용 | `vpc-0dfa5610180dfa628`에 배포. 새 VPC, 서브넷, NAT, 라우트와 엔드포인트를 만들지 않음 | 실제 스택 리소스, `docs/infrastructure-verification.json` |
| CloudFront, Prefix SG, ALB, Fargate | CloudFront HTTPS, Prefix List `pl-22a6434b`의 ALB 80번 접근, 전용 헤더와 기본 403, 웹 8080 연결 확인 | `docs/infrastructure-verification.json` |
| 프라이빗 태스크 | 웹 ENI는 기존 프라이빗 서브넷에 있으며 공인 IP 없음. 수집 일정도 프라이빗 서브넷과 공인 IP 비활성으로 설정 | `docs/infrastructure-verification.json`, `docs/scheduler-verification.json` |
| 편리한 읽기 화면 | 검색, 필터, 날짜 범위, 저장, 공유, 상세, 키보드 탐색, 모바일과 다크 모드 검사 | `docs/frontend-report.md`, `docs/screenshots/production/browser-report.json` |
| 공식 블로그 보충 | 허용된 공식 블로그 링크를 필요할 때 읽으며, 실제 한 블로그 원문을 수집해 비공개 보관 | `data/raw`, S3의 `raw/2026-10-07/kiro-changelog-blog/` |
| 데이터 보호 | S3 공개 차단, AES256, 버전 관리 확인. API는 전체 원문을 노출하지 않음 | `docs/infrastructure-verification.json`, 브라우저/API 검사 |

## 실제 예약 실행

검증 일정은 `2026-10-07T21:11:00Z`로 생성했다. 매일 실행할 일정의 대상, 실행 역할, 네트워크와 재시도 설정을 그대로 사용했다. 일일 일정 자체는 변경하지 않았다.

실제 태스크는 `2f0a65a188b14019bbf6e26776de5f52`다. 수집은 `21:12:05Z`에 시작해 `21:12:24Z`에 완료됐다. 공식 자료 한 건의 해설을 새로 만들었고, 전체 실행은 `success`였다. S3 갱신 시각은 `21:12:26Z`로 확인했다.

CloudWatch에는 `CollectionSuccess=1`, `CollectionFailure=0`이 기록됐다. CloudWatch 지표 조회에서도 21:10 UTC 구간의 성공 합계 1을 확인했다. 검증용 일정은 자동 삭제됐고 `code-pulse` 그룹에는 매일 실행할 일정만 남아 있다.

## 실제 인프라

스택 이름은 `CodePulse`이며 최종 상태는 `UPDATE_COMPLETE`다. CloudFront `ENF217TLIPJIV`는 `Deployed`다.

웹 태스크 `7f7aefdb679545488555a43b49799d51`의 주소는 `10.100.36.172`였으며 공인 IP는 없었다. ALB 대상 한 개가 healthy인 것을 확인했다. 웹 태스크와 수집 태스크 모두 ARM64다.

ALB 인바운드는 CloudFront Prefix List의 TCP 80만 허용한다. 웹 인바운드는 ALB 보안 그룹의 TCP 8080만 허용한다. 수집 태스크에는 인바운드 규칙이 없다. ALB 아웃바운드는 웹 보안 그룹의 8080, 웹과 수집 태스크의 아웃바운드는 HTTPS 443이다.

ALB의 전용 헤더 값과 CloudFront 원본 헤더 값이 일치하며 48자 임의 값인 것을 확인했다. 비밀값 자체는 출력하거나 검증 파일에 저장하지 않았다. CloudFront를 통하지 않은 ALB 직접 연결은 4초 안에 연결되지 않았다. 동시에 공개 CloudFront의 홈페이지, 건강 확인과 피드는 모두 200을 반환했다.

## 배포 중 보완

계정에는 기존 사용자 정의 캐시 정책 19개가 있어 새 정책 두 개를 만드는 첫 배포가 한도 20개에 걸렸다. HTML과 API가 하나의 정책을 공유하도록 바꿨다. TTL은 0/0/60초이며 HTML의 `no-cache`와 API의 최대 60초 캐시 동작을 유지한다. 다른 앱의 정책은 수정하지 않았다.

실패한 스택은 롤백 완료를 확인한 뒤 삭제했다. 남은 빈 실패 큐도 삭제했다. 첫 배포의 사용되지 않은 원본 헤더 비밀은 7일 복구 기간을 두고 2026년 10월 14일 삭제되도록 예약했다. 실제 버킷과 로그 그룹은 존재하지 않았으므로 삭제 작업을 하지 않았다.

계정에서 자동으로 추가하는 GuardDuty 에이전트가 전용 ECR 저장소를 읽지 못하는 문제도 확인했다. 공식 문서에서 서울 리전 저장소를 확인한 뒤 두 실행 역할에 해당 저장소 읽기 권한만 추가했다. 새 웹 태스크에서 GuardDuty가 RUNNING인 것을 확인했고, 수집 태스크에서도 실행 중인 상태를 관찰했다.

## 검증 범위와 운영상 경계

단위/인프라 테스트 76개와 Chromium 브라우저 테스트 31개가 통과했다. 실제 공개 데이터로 검색, 상세 보기, 저장, 공식 링크, 모바일 가로 넘침, 다크 모드와 브라우저 오류도 확인했다. 코드 검토에서 확인된 대표 원문 보존, 대기 해설 재처리, 동시 편집과 화면 상태 문제는 수정 후 재검토를 통과했다.

실행 의존성의 npm 보안 검사 결과는 0개다. 최신 `aws-cdk-lib 2.272.0`에 번들된 개발 전용 `brace-expansion 5.0.9`의 알려진 서비스 거부 취약점 한 건은 남아 있다. npm이 자동으로 갱신할 수 없는 번들이며 런타임 이미지에는 포함하지 않는다.

성공 누락 알람은 완료된 UTC 하루를 평가한다. 배포 전 완료 기간에 데이터가 없어 초기 ALARM을 표시하며, 실제 금일 수집 성공 지표는 별도로 확인했다. 설치된 AWS CLI는 새 평가 창 필드를 생략했으므로 서비스 원본 응답에서 `EvaluationWindow.WallClockWindow.Timezone=UTC`를 확인했다. 이전 날짜에 가짜 성공 지표를 넣지는 않았다.

CloudFront에서 ALB까지는 요청한 기존 사이트 방식의 HTTP 원본 연결이다. 사용자 연결은 HTTPS다. 웹 서버와 CloudFront의 캐시 때문에 편집 내용이 보이기까지 최대 약 2분이 걸릴 수 있다.

Git 저장소가 초기화되지 않은 작업 폴더이므로 Git 작업은 하지 않았다. 소스 코드, 배포 코드와 검증 결과는 현재 작업 폴더에 보관한다.
