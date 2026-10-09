# Code Pulse HTTP and RSS reference

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

### Endpoints

The public base URL is `https://code-pulse.whchoi.net`. Read endpoints require no login. Presence uses a server-issued signed cookie and same-origin requests. Static paths are produced by the [publisher](../../src/publishing/index.ts) and routed by the [stack](../../infra/lib/stack.ts). Backend routes are in [app.ts](../../src/server/app.ts) and [presence.ts](../../src/server/presence.ts).

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/content/ko/feed.json`, `/content/en/feed.json` | Compact catalog for the selected language, with immutable detail and search URLs |
| GET | `/content/objects/<hash>.json` | Complete immutable detail or search index referenced by the catalog |
| GET | `/?lang=en&entry=<id>` | Pre-rendered English detail; omit entry for the listing |
| GET | `/healthz` | Process health: `{"status":"ok","service":"code-pulse"}` |
| GET | `/api/feed` | All published snapshot records, source status, last run, schedule and freshness |
| GET | `/api/entries/:id` | One record by its stable ID; 404 when absent |
| GET | `/feed.xml` | Latest 50 ready Korean explanations as RSS 2.0 |
| GET | `/feed.xml?product=kiro` | Product-specific RSS; also accepts `claude-code` and `codex` |
| GET | `/feed.xml?lang=en` | Latest 50 records in official English; combine with `product` when needed |
| GET | `/api/presence` | Read counts and prepare a signed cookie without recording a visit |
| POST | `/api/presence` | Record activity for that cookie and return updated counts |
| GET | `/robots.txt` | Allow crawler access |

```bash
curl --fail --silent --show-error https://code-pulse.whchoi.net/healthz
curl --fail --silent --show-error https://code-pulse.whchoi.net/content/ko/feed.json
curl --fail --silent --show-error 'https://code-pulse.whchoi.net/feed.xml?product=kiro&lang=en'
```

`/healthz` confirms the server is running; it does not prove the last collection succeeded. GET routes also support HEAD. The edge allows writes only on the exact `/api/presence` behavior.

### Feed and entry fields

[types.ts](../../src/shared/types.ts) defines `Feed`, `FeedEntry`, `SourceStatus` and `Explanation`.

| Field | Meaning |
| --- | --- |
| `generatedAt` | Snapshot generation time; empty before the first snapshot |
| `entries` | Public records, including `pending` explanations |
| `sources` | Per-source `ok`, `error` or `pending` state and available check times |
| `latestRun` | Most recent collection run, when one exists |
| `schedule` | `timezone: "Asia/Seoul"`, `hour: 7` |
| `stale` | Storage fallback, missing successful source checks or checks older than 26 hours |

Static catalogs additionally expose `language`, `searchUrl` and entry `detailUrl`, `detailBytes`, `readRevision`, `contentKind` and `changeSummary`. Catalog summaries omit `fullChanges`, use an empty `references` array and leave secondary explanation fields empty. `changeSummary` supplies `status`, `sourceCount` and `readyCount`; `detailBytes` is the detail JSON byte count. Fetch the referenced detail for all prepared items and references. The separate search index has `{language, entries: [{id, text}]}` and covers the public text for every record in that language. Immutable detail `checkedAt` is empty; the browser overlays the current catalog checking time. `readRevision` is the legacy reader fingerprint, not the private source hash.

Entries include the stable `id`, product and channel, optional version, publication fields, official references and explanation state. A full Korean explanation contains the title, summary, meaning, actions, highlights and evidence. English uses the original title and an excerpt for its overview; the AI-only meaning, action, highlight and audience fields are empty. `datePrecision` distinguishes a source date from an exact timestamp; a day-only record does not establish an actual announcement time.

The feed omits `originalText`, `contentHash` and `explanationModel`. The detail route also excludes the model identifier, but retains `originalText` and `contentHash` as empty strings for compatibility. It does not return the archived source body.

`fullChanges` contains `status`, `sourceCount`, ordered `items` with `id` and text in the selected language, `formatVersion` and `updatedAt`. Its source hash and model are private. A ready short overview does not imply a complete full list. Pending lists expose only the prepared items and an honest source count; legacy records may omit the field. The server verifies full readiness against the current source inventory.

The legacy full APIs accept `lang=ko` or `lang=en`; omission selects Korean. Invalid or repeated `lang` values return 400. English returns every official source item and is labeled `contentKind: source`. It is not an AI-generated English analysis. Korean and English use identical source IDs; private archived-body and model fields remain excluded.

Filtering and pagination are browser behavior. `/api/feed` returns the whole snapshot; parameters such as `product`, `q`, `from`, `to`, `saved` and `unread` belong to the website URL, not a server-side feed filtering contract.

### RSS

RSS accepts `product` and optional `lang=ko` or `lang=en`. English RSS uses official wording and English detail links. Omit `product` for all products, or supply exactly one of `claude-code`, `codex`, `kiro`. Omit `lang` for Korean. Empty, repeated, unknown or additional parameters return 400.

RSS requires a ready overview in the selected language and a valid publication time that is not in the future. A full list may still be pending. It orders records newest first with stable-ID tie-breaking. Each item contains a title, original `pubDate`, overview, article link and an allowed official source link. Korean adds the AI explanation of why the change matters; English presents the official source items. A day-only date is labelled as lacking an announcement time. Article and channel links pin the selected language. Korean item GUIDs retain their previous URL to avoid duplicate subscription items; English item GUIDs use their English detail URL. Visitor information and internal model metadata are excluded. See [rss.ts](../../src/server/rss.ts).

When available, RSS also includes all prepared change items in the selected language as an ordered list. The 50-record subscription limit does not truncate the changes within a record. Incomplete lists state how many source items have been prepared.

### Presence and caching

POST requires the cookie prepared by GET, the exact configured `Origin`, `x-code-pulse-client: 1`, JSON content type and an empty object body `{}`. Missing cookies return 401, invalid origin or client header 403, and a rejected body 400. Oversized bodies can return 413. Backend unavailability returns 503.

Responses contain `active_visitors`, `total_visitors`, `as_of`, `window_seconds` and nullable `counting_since`. The 90-second activity window counts signed browser cookies rather than people. Permanent first-visit markers prevent repeat heartbeats from increasing the cumulative count. The production cookie is HttpOnly, Secure and SameSite=Lax, scoped to `/api/presence`.

S3 catalogs and HTML use `public, max-age=0, s-maxage=60, must-revalidate`; content-addressed objects and assets use `public, max-age=31536000, immutable`. Publication control files are inaccessible through CloudFront.

Presence responses use `no-store`. The legacy API feed, API detail and RSS normally use `public, max-age=30, s-maxage=60`; the server also caches its snapshot for 60 seconds. Storage fallback serves cached data with `no-store`; without cached data, reads return 503. A missing detail returns 404 with `no-store`.

For operating procedures and verification, follow the [runbook](../runbook.md), [architecture](../architecture.md) and [verification record](../verification.md).

## 한국어

### 엔드포인트

공개 기준 주소는 `https://code-pulse.whchoi.net`입니다. 읽기 API는 로그인 없이 사용합니다. 방문 집계는 서버가 발급한 서명 쿠키와 같은 Origin의 요청을 사용합니다. 정적 경로는 [발행기](../../src/publishing/index.ts)가 만들고 [스택](../../infra/lib/stack.ts)이 연결합니다. 백엔드 경로는 [app.ts](../../src/server/app.ts)와 [presence.ts](../../src/server/presence.ts)에 있습니다.

| 메서드 | 경로 | 동작 |
| --- | --- | --- |
| GET | `/content/ko/feed.json`, `/content/en/feed.json` | 선택한 언어의 간결한 목록, 상세 데이터와 검색 색인 주소 |
| GET | `/content/objects/<hash>.json` | 목록이 참조한 전체 상세 또는 검색 색인 |
| GET | `/?lang=en&entry=<id>` | 미리 생성한 영어 상세. 목록은 entry 생략 |
| GET | `/healthz` | 프로세스 상태: `{"status":"ok","service":"code-pulse"}` |
| GET | `/api/feed` | 공개 스냅샷의 전체 기록, 출처 상태, 최근 실행, 일정과 최신성 |
| GET | `/api/entries/:id` | 글 ID로 조회, 없으면 404 |
| GET | `/feed.xml` | 해설이 준비된 최신 글 50개를 RSS 2.0으로 제공 |
| GET | `/feed.xml?product=kiro` | 제품별 RSS, `claude-code`와 `codex`도 허용 |
| GET | `/feed.xml?lang=en` | 최신 영문 기록 50개. `product` 조건과 함께 사용 가능 |
| GET | `/api/presence` | 방문을 기록하지 않고 집계를 읽으며 서명 쿠키 준비 |
| POST | `/api/presence` | 해당 쿠키의 활동을 기록하고 갱신한 집계 반환 |
| GET | `/robots.txt` | 크롤러 접근 허용 |

```bash
curl --fail --silent --show-error https://code-pulse.whchoi.net/healthz
curl --fail --silent --show-error https://code-pulse.whchoi.net/content/ko/feed.json
curl --fail --silent --show-error 'https://code-pulse.whchoi.net/feed.xml?product=kiro&lang=en'
```

`/healthz`는 서버 실행 여부를 확인하며 최근 수집의 성공을 보장하지 않습니다. GET 경로는 HEAD도 지원합니다. 엣지에서 쓰기 요청을 허용하는 경로는 정확히 일치하는 `/api/presence`뿐입니다.

### 피드와 상세 필드

[types.ts](../../src/shared/types.ts)에 `Feed`, `FeedEntry`, `SourceStatus`, `Explanation`을 정의합니다.

| 필드 | 의미 |
| --- | --- |
| `generatedAt` | 스냅샷 생성 시각, 첫 스냅샷 전에는 빈 문자열 |
| `entries` | 해설 `pending` 상태를 포함한 공개 기록 |
| `sources` | 출처별 `ok`, `error`, `pending` 상태와 확인된 시각 |
| `latestRun` | 실행 기록이 있을 때 가장 최근 수집 결과 |
| `schedule` | `timezone: "Asia/Seoul"`, `hour: 7` |
| `stale` | 저장소 캐시 대체, 출처 성공 기록 부재 또는 26시간이 지난 확인 |

정적 목록에는 `language`, `searchUrl`과 글별 `detailUrl`, `detailBytes`, `readRevision`, `contentKind`, `changeSummary`가 추가됩니다. 목록에서는 `fullChanges`를 제외하고 `references` 배열과 부가 해설 필드를 비워 둡니다. `changeSummary`에는 `status`, `sourceCount`, `readyCount`가 있고, `detailBytes`는 상세 JSON의 바이트 수입니다. 준비된 전체 항목과 참고 링크는 상세 주소에서 읽습니다. 별도 검색 색인의 구조는 `{language, entries: [{id, text}]}`이며 해당 언어의 모든 기록에 대해 공개된 텍스트를 담습니다. 고정 주소의 상세 데이터는 `checkedAt`을 빈 문자열로 두며 브라우저가 현재 목록의 확인 시각을 적용합니다. `readRevision`은 읽음 기록용 표식이며 비공개 원문 해시가 아닙니다.

글에는 고정 `id`, 제품과 채널, 선택적 버전, 발표일 필드, 공식 참고 링크와 해설 상태가 들어 있습니다. 한국어 상세 해설에는 제목, 요약, 변경의 의미, 확인할 사항, 주요 내용과 근거가 있습니다. 영어 개요에는 원래 제목과 일부 발췌문을 쓰며 AI 해석에 해당하는 의미, 조치, 하이라이트와 독자 필드는 비워 둡니다. `datePrecision`은 날짜만 제공한 출처와 정확한 시각을 제공한 출처를 구분합니다. 날짜만 있는 글에서 실제 발표 시각을 추정하지 않습니다.

피드에서는 `originalText`, `contentHash`, `explanationModel`을 제외합니다. 상세 응답도 모델 식별자를 제외하지만 호환성을 위해 `originalText`와 `contentHash`는 빈 문자열로 남깁니다. 보관한 원문 본문은 반환하지 않습니다.

`fullChanges`에는 `status`, `sourceCount`, 원문 순서의 `items`(`id`와 선택한 언어의 `text`), `formatVersion`, `updatedAt`이 들어 있습니다. 원문 해시와 모델은 비공개입니다. 짧은 개요가 준비됐어도 전체 목록은 미완성일 수 있습니다. 준비 중인 목록은 생성한 항목과 실제 원문 개수를 표시하며, 이전 형식의 글은 이 필드가 없을 수 있습니다. 서버는 현재 원문 항목과 대조해 전체 완료 여부를 확인합니다.

호환 전체 API는 `lang=ko`와 `lang=en`을 허용하며 생략하면 한국어입니다. 잘못된 `lang` 값이나 중복 지정은 400을 반환합니다. 영어는 공식 원문의 모든 항목을 `contentKind: source`로 제공합니다. 영어 AI 분석으로 표시하지 않습니다. 두 언어는 같은 원문 항목 ID를 사용하며 보관용 원문 필드와 모델 정보는 제외합니다.

필터와 페이지 구분은 브라우저가 처리합니다. `/api/feed`는 전체 스냅샷을 반환합니다. `product`, `q`, `from`, `to`, `saved`, `unread`는 웹사이트 주소에서 사용하는 조건이며 서버 피드 필터 계약이 아닙니다.

### RSS

RSS는 `product`와 선택적인 `lang=ko`, `lang=en`을 허용합니다. 영어 피드는 공식 영문과 영어 상세 주소를 제공합니다. `product`를 생략하면 전체 제품을, 지정하면 `claude-code`, `codex`, `kiro` 중 하나를 제공합니다. `lang`을 생략하면 한국어입니다. 빈 값, 중복 지정, 알 수 없는 값이나 추가 매개변수는 400을 반환합니다.

선택한 언어의 개요가 준비됐고 발표 시각이 유효한 글 중 미래 발표를 제외합니다. 전체 목록은 아직 준비 중일 수 있습니다. 최신 발표순으로 정렬하고 시각이 같으면 고정 ID로 순서를 정합니다. 항목에는 제목, 원문 `pubDate`, 개요, 글 링크와 허용된 공식 원문 링크를 담습니다. 한국어는 변경의 의미에 대한 AI 해설을 더하고, 영어는 공식 원문 항목을 제공합니다. 날짜만 있는 글에는 발표 시각이 제공되지 않았음을 표시합니다. 글과 채널 주소에는 선택 언어를 명시합니다. 한국어 GUID는 기존 구독에 중복 글이 생기지 않도록 이전 주소를 유지하며, 영어 GUID는 영어 상세 주소를 사용합니다. 방문 정보와 내부 모델 메타데이터는 포함하지 않습니다. 구현은 [rss.ts](../../src/server/rss.ts)에 있습니다.

전체 목록이 있으면 선택한 언어의 모든 항목을 순서 있는 목록으로 RSS에도 넣습니다. 구독 피드의 글 50개 제한으로 한 글의 변경 목록을 자르지 않습니다. 미완성 목록에는 원문 항목 중 준비한 개수를 표시합니다.

### 방문 집계와 캐시

POST에는 GET으로 준비한 쿠키, 설정값과 정확히 일치하는 `Origin`, `x-code-pulse-client: 1`, JSON 콘텐츠 타입과 빈 객체 `{}` 본문이 필요합니다. 쿠키가 없으면 401, Origin이나 클라이언트 헤더가 올바르지 않으면 403, 허용하지 않는 본문이면 400을 반환합니다. 본문이 너무 크면 413이 나올 수 있으며 저장소를 사용할 수 없으면 503입니다.

응답 필드는 `active_visitors`, `total_visitors`, `as_of`, `window_seconds`, null이 가능한 `counting_since`입니다. 최근 90초의 활동은 사람 수가 아니라 서명된 브라우저 쿠키를 기준으로 집계합니다. 영구 첫 방문 표식으로 반복 활동이 누적 방문을 늘리지 않게 합니다. 운영 쿠키는 HttpOnly, Secure, SameSite=Lax이며 경로는 `/api/presence`입니다.

S3 목록과 HTML은 `public, max-age=0, s-maxage=60, must-revalidate`, 내용 해시로 주소를 정한 상세 파일과 자산은 `public, max-age=31536000, immutable`을 사용합니다. CloudFront에서 발행 제어 파일은 읽을 수 없습니다.

방문 응답은 `no-store`입니다. 호환 API의 피드와 상세, RSS의 일반 응답은 `public, max-age=30, s-maxage=60`을 사용하며 서버도 스냅샷을 60초 동안 캐시합니다. 저장소 장애 시 이전 캐시가 있으면 `no-store`로 제공하고 없으면 503을 반환합니다. 없는 글의 상세 조회는 `no-store`와 404를 반환합니다.

운영 절차와 검증은 [운영 안내](../runbook.md), [아키텍처](../architecture.md), [검증 기록](../verification.md)을 참고합니다.
