# Static delivery and language support

[English](#english) | [한국어](#한국어)

## English

### Read and publish paths

CloudFront reads pre-rendered pages, compact catalogs and complete detail/search objects from a separate private S3 bucket using OAC. The existing protected ALB and private Fargate service continue to serve `/api/*`, `/feed.xml` and `/healthz`. Visitor counts still use the signed cookie and DynamoDB. Neither the snapshot bucket nor `_publication/` controls are readable through CloudFront.

The collector publishes both languages after its final snapshot write. Editorial and backfill tools also publish when `SITE_BUCKET` or `SITE_DIR` is set. A publication failure is reported as an execution failure; it does not delete previous assets. Immutable dependencies are uploaded first, then individual pages, then catalogs. Conditional control and object writes reject superseded publishers. Individual S3 replacements are atomic; a whole site is not one atomic S3 operation, and readers may briefly receive pages from adjacent publications.

English contains every official source item with its section context. It is explicitly labeled as official English wording. Korean retains the Haiku 5.5 explanation and editorial process. Both languages share source item IDs, original publication dates and the same reader revision.

### Loading and caching

A listing embeds its compact catalog and renders the first 20 cards before JavaScript starts. Remaining links are available without JavaScript. A detail page embeds its complete record. The browser downloads the separate full search index only after a search is entered; it does not silently search only summaries. Saved export resolves every selected detail before producing Markdown.

The browser prefetches cards within 400px of the viewport with at most two requests at a time. It avoids background prefetch on hidden pages, offline connections, Save-Data and 2G. Detail and search memory is bounded to 80 objects and 16 MiB, with older entries evicted first. Hashed URLs also use the browser HTTP cache. A changed URL prevents reuse of outdated content. Rechecking a source alone does not change its detail URL or read state; the catalog supplies the latest check time.

HTML and catalogs use `max-age=0, s-maxage=60, must-revalidate`. Content and compiled assets have content hashes in their URLs and one-year immutable caching. The browser rechecks catalogs at most once a minute while visible and online, and after returning to the page. Failed refreshes preserve readable data with a stale notice. Edge caching and the browser refresh interval can together delay an already open page by about two minutes. Preserve old content-addressed objects because cached HTML and existing browser sessions may still reference them.

The top language switch updates `lang=ko` or `lang=en` in the URL and stores `code-pulse-language`. Explicit URL language wins over the saved preference. Sharing, RSS and Markdown retain the chosen language. The collection schedule is **07:00 Asia/Seoul**, defined in `src/shared/schedule.ts`.

### Local publication and preview

Use Node 22 or newer. Select the data source explicitly; production data and local files must not be mixed accidentally.

```bash
npm run build
node --import tsx tools/publish-site.ts --data-dir ./data --site-dir ./data/site --report /tmp/code-pulse-site.json
SITE_DIR=./data/site DATA_DIR=./data npm start
```

Open `http://localhost:8080/?lang=en` or `/?lang=ko&entry=<id>`. The preview server uses the same query-to-page mapping as CloudFront and blocks publication controls. Built local development can fall back to the full legacy API only on a loopback hostname when static content is absent. The public site never downloads the full legacy feed as a fallback.

`SITE_BUCKET` and `SITE_DIR` are mutually exclusive. `STATIC_DIR` selects the compiled frontend to publish and defaults to `./dist/public`. The container includes the same publisher as `node dist/publishing/run.js`.

### Deploying updates

For an established static deployment, build the application, validate it and deploy the new worker/web image. Then publish the compiled site from the current production snapshot. Set the bucket names from the verified `cdk-outputs.json`; do not point the site publisher at the data bucket.

```bash
npm run typecheck
npm test
npm run test:browser
npm run build
npm run synth -- --no-lookups
npm run deploy
node --import tsx tools/publish-site.ts --data-bucket <DataBucketName> --site-bucket <SiteBucketName> --report /tmp/code-pulse-publication.json
```

The daily collector publishes the same build after collecting. Application UI changes require this explicit static publication after deploying; updating only the web task does not replace S3 pages. Include manifest, lockfile and bilingual release notes in version changes and run `npm run release:check` before deployment.

For the first transition from ALB-served HTML, provision with `--context staticRouting=false --context retainedWebImage=<current-web-ECR-image>`. This keeps the existing web image and ALB read path while adding the bucket, new collector and a separate static routing function. The original canonical-host function is unchanged; the distribution switches its static function association and S3 origin together. Publish the new static site, preserve the old HTML's referenced assets at their original URLs, and verify all pages and content before deploying again with default static routing. Do not enable the S3 default origin before it is populated.

### Verification and recovery

Check both languages, original shared links, English RSS, complete source counts, saved export and browser errors. Verify a missing page returns 404, private controls are denied, and direct unsigned S3 access is denied. Confirm the real EventBridge schedule, a completed collector task and its `site_published` / `collection_completed` events. Use `tools/verify-static-content.ts` for every published item and full search text, `tools/verify-bilingual-browser.mjs` for production language/cache/JavaScript-free checks, and `tools/verify-infrastructure.mjs --output docs/static-infrastructure-verification.json` for the deployed boundary. Use `tools/measure-delivery.mjs` to compare the same browser and network conditions; it records source and conditions instead of promising a universal loading time.

On a publication conflict, reload the current snapshot and rerun the publisher. A completed identical build returns `unchanged`. On failed uploads, repair the cause and rerun; previously uploaded immutable objects are reused. Do not delete old objects or copy an old publication control file over a newer one. To restore a prior application build, publish that compiled build against the current snapshot so newer collected records remain present. The temporary `staticRouting=false` setting can restore ALB serving if the backend and its assets have first been verified.

## 한국어

### 조회와 발행 경로

CloudFront는 OAC로 별도 비공개 S3 버킷의 HTML, 간결한 목록, 전체 상세 데이터와 검색 색인을 읽습니다. 기존 보안 경계 안의 ALB와 프라이빗 Fargate는 `/api/*`, `/feed.xml`, `/healthz`를 계속 제공합니다. 방문 집계는 서명 쿠키와 DynamoDB를 사용합니다. 스냅샷 버킷과 `_publication/` 제어 기록은 CloudFront에서 읽을 수 없습니다.

수집기는 최종 스냅샷 저장 후 두 언어를 발행합니다. 편집과 백필 도구도 `SITE_BUCKET`이나 `SITE_DIR`이 있으면 발행합니다. 발행 실패는 실행 실패로 기록하며 이전 자산은 삭제하지 않습니다. 고정 주소의 상세 파일을 먼저 올리고, 개별 페이지를 만든 뒤 목록을 갱신합니다. 제어 기록과 파일별 조건부 쓰기로 더 최신인 발행 결과를 오래된 작업이 덮어쓰지 못하게 합니다. 개별 S3 파일 교체는 원자적이지만 사이트 전체가 한 번에 바뀌지는 않으므로 잠시 서로 인접한 발행본의 페이지가 보일 수 있습니다.

영어는 공식 원문의 모든 항목과 구역 정보를 제공하며 공식 영문임을 표시합니다. 한국어는 Haiku 5.5 해설과 윤문 과정을 유지합니다. 두 언어에서 원문 항목 ID, 발표일과 읽음 변경 표식을 공유합니다.

### 로딩과 캐시

목록 HTML에는 간결한 목록 데이터를 넣고 JavaScript 실행 전에 첫 20개 글을 표시합니다. JavaScript를 끄면 나머지 글 링크도 볼 수 있습니다. 상세 HTML에는 해당 글 전체를 넣습니다. 전체 검색 색인은 검색어를 입력한 뒤 읽으며 요약만 검색한 결과를 전체 결과로 표시하지 않습니다. 저장 글 내보내기는 선택한 상세 내용을 모두 받은 뒤 파일을 만듭니다.

브라우저는 화면에서 400px 이내로 가까워진 글을 최대 두 개씩 미리 읽습니다. 화면이 숨겨져 있거나 오프라인, 데이터 절약, 2G 상태이면 사전 읽기를 하지 않습니다. 상세와 검색 메모리 캐시는 최대 80개 객체, 16MiB이며 오래 사용하지 않은 항목부터 비웁니다. 내용 해시가 있는 주소는 브라우저 HTTP 캐시도 사용합니다. 내용이 바뀌어 주소가 달라지면 이전 파일을 재사용하지 않습니다. 출처 확인 시각만 바뀌면 상세 주소와 읽음 상태는 유지하고 목록에서 최신 확인 시각을 가져옵니다.

HTML과 목록은 `max-age=0, s-maxage=60, must-revalidate`를 사용합니다. 상세와 빌드 자산은 내용 해시를 주소에 넣고 1년간 캐시합니다. 브라우저는 화면이 보이고 온라인일 때 최대 1분에 한 번, 또는 페이지로 돌아온 뒤 목록을 다시 확인합니다. 갱신에 실패하면 이전 데이터와 최신성 안내를 함께 제공합니다. 엣지 캐시와 브라우저 갱신 주기가 겹치면 이미 열린 화면의 반영은 약 2분까지 걸릴 수 있습니다. 캐시된 HTML이나 기존 세션이 사용할 수 있으므로 이전 고정 주소의 파일은 보존합니다.

상단 언어 전환은 URL에 `lang=ko`나 `lang=en`을 쓰고 `code-pulse-language`에 선택을 저장합니다. URL의 언어가 저장한 선택보다 우선합니다. 공유, RSS와 Markdown도 선택한 언어를 유지합니다. 수집 시각은 **07:00 Asia/Seoul**이며 `src/shared/schedule.ts`에서 정합니다.

### 로컬 발행과 미리보기

Node 22 이상을 사용합니다. 운영 데이터와 로컬 파일이 섞이지 않도록 데이터 출처를 명시합니다.

```bash
npm run build
node --import tsx tools/publish-site.ts --data-dir ./data --site-dir ./data/site --report /tmp/code-pulse-site.json
SITE_DIR=./data/site DATA_DIR=./data npm start
```

`http://localhost:8080/?lang=en` 또는 `/?lang=ko&entry=<id>`를 엽니다. 미리보기 서버는 CloudFront와 같은 주소 변환을 사용하고 발행 제어 기록을 차단합니다. 정적 파일이 없는 로컬 빌드에서는 루프백 호스트에 한해 기존 전체 API를 사용할 수 있습니다. 공개 사이트는 정적 조회 실패를 전체 피드 다운로드로 대체하지 않습니다.

`SITE_BUCKET`과 `SITE_DIR`은 함께 쓸 수 없습니다. `STATIC_DIR`은 발행할 빌드 화면을 선택하며 기본값은 `./dist/public`입니다. 컨테이너에도 같은 발행기를 `node dist/publishing/run.js`로 포함합니다.

### 변경 배포

정적 배포가 구성된 환경에서는 빌드와 검증 후 새 수집기 및 웹 이미지를 배포하고, 현재 운영 스냅샷에서 정적 사이트를 발행합니다. 버킷 이름은 확인한 `cdk-outputs.json`을 사용하며 사이트 발행 대상을 데이터 버킷으로 지정하지 않습니다.

```bash
npm run typecheck
npm test
npm run test:browser
npm run build
npm run synth -- --no-lookups
npm run deploy
node --import tsx tools/publish-site.ts --data-bucket <DataBucketName> --site-bucket <SiteBucketName> --report /tmp/code-pulse-publication.json
```

일일 수집기는 수집 후 같은 빌드를 발행합니다. 화면 기능을 바꿨을 때도 배포 후 정적 발행을 실행해야 합니다. 웹 태스크만 바꿔서는 S3 페이지가 바뀌지 않습니다. 버전 변경에는 manifest, 잠금 파일과 두 언어 릴리스 노트를 함께 반영하고 배포 전 `npm run release:check`를 실행합니다.

ALB 화면에서 처음 전환할 때는 `--context staticRouting=false --context retainedWebImage=<현재-웹-ECR-이미지>`로 버킷과 새 수집기를 준비합니다. 기존 웹 이미지와 ALB 조회 경로는 유지하면서 정적 주소 변환 함수를 별도로 준비합니다. 기존 도메인 리디렉션 함수는 그대로 두고 배포 설정에서 S3 원본과 정적 함수 연결을 함께 전환합니다. 새 정적 사이트를 발행하고 이전 HTML이 참조한 자산도 원래 주소에 보존한 뒤, 파일과 화면 검증을 마치고 기본 정적 경로로 다시 배포합니다. S3를 채우기 전에 기본 원본을 전환하지 않습니다.

### 검증과 복구

두 언어 화면, 기존 공유 주소, 영어 RSS, 전체 원문 항목 수, 저장 글 내보내기와 브라우저 오류를 확인합니다. 없는 페이지의 404, 제어 기록 차단과 서명 없는 S3 직접 접근 차단도 확인합니다. 실제 EventBridge 일정, 종료된 수집 태스크의 상태와 `site_published`, `collection_completed` 로그를 확인합니다. `tools/verify-static-content.ts`로 모든 공개 항목과 검색 본문을, `tools/verify-bilingual-browser.mjs`로 운영 언어와 캐시 및 JavaScript 없는 화면을 확인합니다. 실제 경계는 `tools/verify-infrastructure.mjs --output docs/static-infrastructure-verification.json`로 확인합니다. `tools/measure-delivery.mjs`는 같은 브라우저와 네트워크 조건에서 전후 시간을 비교하며 모든 독자에게 같은 속도를 보장하지 않습니다.

발행 충돌이 나면 현재 스냅샷을 다시 읽어 재실행합니다. 완료된 빌드와 내용이 같으면 `unchanged`를 반환합니다. 업로드 실패의 원인을 고치고 재실행하면 먼저 올린 고정 파일을 재사용합니다. 오래된 제어 기록으로 새 기록을 덮거나 이전 자산을 삭제하지 않습니다. 이전 앱 빌드로 복구할 때도 현재 스냅샷을 사용해 새로 수집한 기록을 보존합니다. 백엔드와 필요한 자산을 먼저 확인했다면 `staticRouting=false`로 ALB 조회 경로를 복원할 수 있습니다.
