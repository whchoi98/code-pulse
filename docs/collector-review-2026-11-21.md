# Collector review, 2026-11-21 | 수집기 점검

[English](#english) | [한국어](#한국어)

## English

The 07:01 KST production run reported four failures among six sources. The schedule fired and the site stayed online. Comparing the production snapshot, public details and official responses showed which records readers could still find.

| Source | Evidence and reader impact |
| --- | --- |
| Kiro changelog | The 07:01 run still showed November 5 as the latest publication. The first comparison found 250 official 2026 records: 215 already had matching IDs and publication dates; 35 were missing (682 source items). Another read of all 21 official pages during recovery found the November 20 Frankfurt preview announcement, adding one record with three items. That brought the total to 251 official records, plus the site's older October 19 IDE 1.4.5 entry no longer in the official list. |
| Codex GitHub releases | Last successful check: November 6 KST. The GitHub web route returned JSON to the collector's `Accept` header. The same route returned release sections when asked for HTML. With that single change in a read-only replay, the existing parser read 15 stable releases in the latest 45 days. All 15 versions were on the site, but eight came from RSS only. Their public details lacked the GitHub release reference and had day precision rather than the release timestamp. |
| Codex changelog RSS | The production reader found 182 eligible entries from January 1 through the review. All were present in the public catalog; the latest was CLI 0.171.0 on November 20 UTC. |
| Claude Code GitHub releases | The production reader found 261 eligible releases from January 1. The latest, 2.1.330, was published at 07:32:56 KST on November 21, **after** the daily run. All releases available when the run began were already public. |
| Claude Code English changelog | Last successful check: October 20 KST. The official response was Markdown with bold version labels and dates, without the MDX `<Update>` blocks the parser required. The document contained 270 dated versions for 2026. During recollection, all 270 were in the production snapshot, but 22 lacked the English changelog reference. |
| Claude Code Korean weekly recaps | Last successful check: October 20 KST. The Markdown response no longer contained the expected MDX version tags. The official HTML still had explicit version ranges for all 24 recaps. All 146 matching releases retained their weekly detail links. Recaps supply context; their coverage periods are not release dates. |

The web service completed its rollout at revision 9 (one desired task, one running). The enabled 07:00 `Asia/Seoul` schedule pointed to collector revision 9, and its dead-letter queue was empty. The missing-success alarm had been in `ALARM` since October 15 with no directly configured alarm action. The alarm establishes an absence of fully successful runs, not the cause on that date.

The first recovery task (`b220d47cf02a48ca8d455f9d9861120d`) stopped at the collector's 20-minute limit with exit code 1 before publication. Its checkpoints retained all 36 new records, 31 Korean overviews and 30 complete Korean change lists. A full-history run with many model calls can therefore update the private snapshot while the public catalog remains on the previous generation.

The retry (`2e7ae79dc6034ee391682781be58e810`) finished collection at 11:00:17 KST and published generation 47: 770 records and 1,542 HTML pages. The worker logged `site_published` and `collection_completed` and stopped with exit code 2 (`partial`). The three remaining source errors were Codex GitHub and the two Claude documentation feeds. The retry reported zero new records because the first task had already saved them.

At 11:02 KST the Korean and English public catalogs had the same publication ID. Each contained 252 Kiro records, including all 216 earlier IDs with their original dates. All 72 new detail files were checked: the English inventory contained all 685 official items in order, and every ID had a validated Korean item in the same position. The IDE 1.5.11 shared pages and its English RSS item matched the official title and publication date. The live browser reported application version 1.5.1, no page errors or failed responses, and rendered both languages with JavaScript disabled. One **older** record remained incomplete: Crew 0.9.0 (October 16) showed all 73 English items and 35 validated Korean items. Its other 38 Korean items were not marked ready.

For Codex, request HTML on GitHub web release routes and keep JSON on the API. For Claude Code, read explicitly dated English sections including collapsed lists, and bind Korean weekly references only to documented version ranges. Replay current official fixtures through the readers before deploying either change. The [runbook](runbook.md) describes how to verify source health and publication.

## 한국어

오전 7시 1분 정기 실행에서 여섯 출처 중 네 곳이 실패했다. 일정은 제때 실행됐고 사이트도 열렸다. 운영 스냅샷, 공개 상세 페이지와 공식 응답을 대조해 어떤 기록을 독자가 볼 수 있었는지 확인했다.

| 출처 | 확인 결과와 독자에게 미친 영향 |
| --- | --- |
| Kiro 변경 기록 | 오전 7시 1분 실행에서 마지막 발표일은 여전히 11월 5일이었다. 처음 대조한 올해 공식 기록 250건 중 215건은 공개된 글의 ID와 발표일이 일치했다. 빠진 35건에는 원문 항목 682개가 있었다. 복구 도중 공식 목록 21페이지를 다시 읽었을 때는 11월 20일자 프랑크푸르트 프리뷰 공지 한 건과 항목 세 개가 더 있었다. 공식 기록은 총 251건이며, 10월 19일자 IDE 1.4.5는 공식 목록에서 사라졌지만 사이트에 남아 있었다. |
| Codex GitHub 릴리스 | 마지막 수집 성공일은 한국 시간 11월 6일이다. GitHub 웹 페이지는 수집기의 `Accept` 헤더에 JSON을 반환했고, HTML을 명시하면 릴리스 목록을 반환했다. 요청 형식만 바꾼 읽기 전용 재검증에서 기존 파서가 최근 45일의 안정판 15개를 읽었다. 15개 모두 사이트에 있었지만 8개는 RSS로만 들어왔다. 이 8개의 상세 페이지에는 GitHub 릴리스 링크가 없고 발표일은 날짜 단위로만 표시됐다. |
| Codex 공식 RSS | 운영 파서로 1월 1일부터 점검 시점까지 읽은 182건이 모두 공개 목록에 있었다. 최신 글은 UTC 11월 20일에 발표된 CLI 0.171.0이었다. |
| Claude Code GitHub 릴리스 | 운영 파서로 올해 릴리스 261개를 확인했다. 최신 버전 2.1.330은 11월 21일 오전 7시 32분 56초(한국 시간)에 발표됐다. 정기 실행이 시작될 때 이미 발표된 릴리스는 모두 사이트에 있었다. |
| Claude Code 영문 변경 기록 | 마지막 수집 성공일은 한국 시간 10월 20일이다. 공식 Markdown에는 굵은 글씨로 표시한 버전과 발표일이 있었지만 파서가 찾는 MDX `<Update>` 블록은 없었다. 올해 발표일이 명시된 버전 270개는 재수집 도중 모두 운영 저장소에서 확인됐고, 그중 22개에는 영문 변경 기록 링크가 없었다. |
| Claude Code 한국어 주간 소식 | 마지막 수집 성공일은 한국 시간 10월 20일이다. Markdown에는 파서가 찾는 MDX 버전 태그가 없었다. 공식 HTML에는 주간 요약 24개 모두에 적용 버전 범위가 명시돼 있었고, 해당 릴리스 146개에는 기존 주간 상세 링크가 모두 남아 있었다. 주간 요약은 개별 릴리스의 배경 자료다. 요약 기간은 발표일로 쓰지 않는다. |

웹 서비스는 revision 9 배포를 마쳤고, 필요한 태스크 한 개가 실행 중이었다. 매일 오전 7시(`Asia/Seoul`) 일정은 활성 상태로 수집기 revision 9를 가리켰다. 실행 요청 실패 대기열은 비어 있었다. 수집 성공 누락 경보는 10월 15일부터 `ALARM`이었고 직접 연결된 알림 동작은 없었다. 이 경보로는 전체 수집이 성공하지 않았다는 점만 알 수 있으며, 그날의 실패 원인까지 특정할 수는 없다.

첫 복구 태스크(`b220d47cf02a48ca8d455f9d9861120d`)는 20분 실행 한도에 걸려 발행 전에 종료 코드 1로 멈췄다. 그때까지 새 글 36건, 한국어 개요 31건, 한국어 전체 변경 목록 30건을 저장했다. 전체 이력을 재수집하면서 모델을 여러 번 호출할 때는 운영 저장소가 갱신돼도 공개 목록은 이전 판에 머물 수 있다.

재시도 태스크(`2e7ae79dc6034ee391682781be58e810`)는 한국 시간 오전 11시 0분 17초에 수집을 마치고 글 770건, HTML 페이지 1,542개를 47번째 발행본으로 공개했다. `site_published`와 `collection_completed`가 모두 기록됐고 종료 코드는 2(`partial`)였다. 실패한 출처는 Codex GitHub와 Claude 문서 두 곳이었다. 재시도에서 신규 글이 0건으로 집계된 이유는 첫 작업이 이미 글을 저장했기 때문이다.

오전 11시 2분에 확인한 한국어와 영어 공개 목록의 발행 ID는 같았다. 두 목록 모두 Kiro 글 252건이었고, 기존 216건의 ID와 발표일이 그대로였다. 새 상세 파일 72개를 모두 대조했다. 영문에는 공식 항목 685개가 원래 순서대로 있었고, 한국어에도 같은 ID에 대응하는 검증된 항목이 같은 순서로 실렸다. IDE 1.5.11의 두 언어 상세 페이지와 영어 RSS 항목에서 공식 제목과 발표일을 확인했다. 실제 브라우저에는 앱 버전 1.5.1이 표시됐고 페이지 오류나 실패한 응답은 없었다. JavaScript를 끄고도 두 언어 모두 읽을 수 있었다. **기존 글** 중 미완료인 것은 10월 16일자 Crew 0.9.0 한 건이다. 영문 원문은 73개 모두 공개됐고, 한국어는 검증된 35개만 공개됐다. 남은 38개는 완료로 표시하지 않았다.

Codex는 GitHub 웹 릴리스 경로에 HTML을 요청하고 API에는 JSON 요청을 유지하면 된다. Claude Code는 영문 버전별 발표일과 접힌 목록 안의 변경 사항까지 읽고, 한국어 주간 링크는 명시된 버전 범위에만 연결해야 한다. 두 변경 모두 현재의 공식 응답을 재현한 테스트를 거쳐야 한다. 출처의 성공 상태와 공개 상세 내용까지 확인하는 절차는 [운영 안내서](runbook.md)에 있다.
