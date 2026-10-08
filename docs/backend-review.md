# 수집기와 API 독립 검토

검토일: 2026-10-07. `docs/backend-review-task.md`, 설계 문서, 계획의 Task 1을 기준으로 수집기, 저장소, 공개 API, 해설 생성과 윤문 도구, 해당 테스트를 읽었다. 구현 파일은 변경하지 않았다.

## [IMPORTANT / P1] RSS가 저장된 GitHub 대표 원문과 완성된 해설을 덮어쓴다 (confidence: 100)

**위치:** `src/collector/engine.ts:124`, `src/collector/engine.ts:175`, `src/collector/engine.ts:66`

현재 실행의 후보끼리는 GitHub를 우선하지만, 후보를 만들 때 이전 스냅샷의 대표 출처는 고려하지 않는다. 같은 버전의 RSS 항목만 이번 실행에 들어오면 기존 GitHub 항목과 ID가 같아지고, 제목 차이 때문에 원문 수정으로 처리된다. 이후 병합은 RSS 항목 전체로 기존 항목을 교체한다.

GitHub 장애뿐 아니라 오래된 릴리스가 첫 페이지에서 빠질 때도 발생한다. `src/collector/sources.ts:40`은 Codex GitHub 응답을 20개로 제한한다. 실제 보관된 응답 세 개 모두 20개 중 안정판이 2개였고, 안정판 발표 범위는 10월 5일부터 7일까지였다. RSS에는 더 오래된 버전이 남아 있다.

메모리 저장소에서 같은 Codex 0.161.0을 두 출처로 수집한 뒤 GitHub만 실패시키고 모델도 실패시키자 다음과 같이 바뀌었다.

| 항목 | 변경 전 | 변경 후 |
| --- | --- | --- |
| 대표 출처 | `codex-releases` | `codex-changelog` |
| 발표 시각 | `2026-10-07T15:58:45.000Z` | `2026-10-07T00:00:00.000Z` |
| 해설 상태 | `ready` | `pending` |
| 공식 링크 수 | 2 | 1 |

모델 호출이 성공해도 대표 원문, 정확한 발표 시각, GitHub 링크는 사라지고 불필요한 재생성 비용이 든다.

**수정 제안:** 현재 후보와 저장된 항목 사이에도 같은 대표 출처 우선순위를 적용한다. 이미 GitHub 원문을 보유한 같은 버전에 RSS만 들어오면 대표 본문, 발표 시각, 해설을 유지하고 공식 링크만 합친다. 해당 GitHub 원문을 다시 관찰해 실제 내용이 달라졌을 때 재생성한다.

## [IMPORTANT / P2] 현재 피드에서 빠진 pending 항목은 재시도하지 않고 실행을 성공으로 기록한다 (confidence: 100)

**위치:** `src/collector/engine.ts:116`, `src/collector/engine.ts:159`, `src/collector/engine.ts:207`

해설 작업 목록을 이번에 가져온 유효 기간 내 후보만으로 만든다. 저장된 `pending` 항목은 원문을 보유하고 있어도 새 피드에 다시 나타나지 않으면 작업 목록에 들어가지 않는다. 첫 페이지에서 밀리거나 조회 기간을 벗어난 항목이 영구적으로 준비 중 상태에 남는다. 출처 장애 중에도 보관된 원문으로 해설을 재시도할 수 없다.

재현에서는 0.161.0의 모델 호출을 실패시켜 저장한 다음, 다음 실행의 GitHub 응답에는 0.162.0만 넣었다. 해설 호출은 0.162.0에만 발생했고 0.161.0은 계속 `pending`이었다. 그럼에도 반환된 실행 상태는 `success`였다. `pending` 수 역시 이번 작업 목록에서만 집계하기 때문이다.

**수정 제안:** 저장된 `pending` 항목을 재시도 대기열에 합치고, 새 후보가 있으면 최신 원문으로 대체한다. 완료 시 남은 재시도 항목을 기준으로 실행 상태를 계산한다. 조회 기간은 새로운 자료를 찾는 범위로 사용하고, 이미 보관한 실패 항목의 재시도를 종료하는 조건과 분리한다.

## [IMPORTANT / P2] ETag 충돌 재시도가 최신 윤문을 오래된 해설로 되돌린다 (confidence: 100)

**위치:** `src/collector/engine.ts:61`, `src/collector/engine.ts:66`, `src/collector/engine.ts:179`

수집기는 시작할 때 읽은 해설과 `editorialVersion`, `explanationEditedAt`을 작업 항목에 복사한다. 그 사이 윤문 도구가 같은 원문의 해설을 저장하면 ETag 충돌은 올바르게 발생한다. 그러나 재읽기 후 병합은 `checkedAt`과 해설 존재 여부만 비교하므로, 같은 `contentHash`의 최신 윤문을 수집 시작 시점의 오래된 해설로 덮어쓴다. 윤문 도구는 원문 확인 시각인 `checkedAt`을 바꾸지 않아 현재 비교로 보호되지 않는다.

메모리 저장소에서 수집기의 첫 쓰기 직전에 다른 작업이 `human-ton-2` 해설과 더 늦은 편집 시각을 저장하도록 했다. ETag 충돌 후 수집은 완료됐지만 최종 제목이 이전 제목으로 돌아갔고, 새 편집 버전과 편집 시각도 사라졌다.

`tools/polish-content.ts:15`의 재시도 병합도 원문 해시만 비교하므로, 두 편집 작업 사이에서는 같은 종류의 오래된 해설 덮어쓰기가 가능하다.

**수정 제안:** 원문 관찰과 해설 편집의 갱신 순서를 별도로 비교한다. 원문 해시가 같으면 더 최신의 `explanationEditedAt`과 완료된 해설을 보존하고, 수집기가 생성하지 않은 기존 해설 복사본으로 최신 편집을 대체하지 않는다. 윤문 도구에도 같은 병합 규칙을 적용한다.

## 검증 기록

- Node 22와 `tsx`로 위 세 상황을 메모리 저장소에서 직접 재현했다. 원격 요청과 모델 호출은 수행하지 않았다.
- 읽은 `data/snapshot.json`에는 75개 항목이 있었다. Claude Code 41개, Codex 24개, Kiro 10개였고, `pending`과 미래 발표는 없었다. 75개 해설 모두 현재 `validateExplanation`의 인용, 한국어 문체, 코드 검증을 통과했다.
- 보관된 공식 응답을 현재 파서로 읽었다. Claude Code 99개, Codex GitHub 안정판 2개, Codex RSS 125개, Kiro 10개가 파싱됐다.
- 공개 API의 원문 제거, 읽기 실패 시 stale 응답, 읽기 전용 라우트, 공식 URL과 리디렉션 검증, S3 조건부 쓰기와 체크포인트의 완료 기록 제외는 코드와 기존 테스트를 확인했다. 이번 검토에서 전체 테스트를 반복 실행하지 않았다.

## 2026-10-07 수집 엔진 수정 재검토

`docs/backend-fixes.md`와 수정된 `src/collector/engine.ts`, `tests/engine.test.ts`를 다시 읽었다. 위 최초 발견 사항은 수정 전 동작의 기록이며, 아래 판정은 이번 엔진 수정에 대한 결과다.

| 검토 항목 | 판정 | 수정 확인 |
| --- | --- | --- |
| 저장된 GitHub 대표 원문 유지와 RSS에서 GitHub로 승격 | 해결 | `engine.ts:43`의 병합과 `engine.ts:158`의 작업 목록에서 저장된 GitHub를 우선한다. RSS만 다시 관찰했을 때 본문, 발표 시각, 기존 해설과 원문 확인 시각을 유지한다. 실제 GitHub 수정과 대표 출처 승격은 반영하고, 두 출처의 링크와 최초 발견 시각을 보존한다. |
| 저장된 pending 재시도와 최종 실행 상태 | 해결 | `engine.ts:168`에서 피드와 조회 기간에 없는 대기 항목도 작업 목록에 넣는다. 원문을 다시 확인하지 않은 재시도는 기존 확인 시각을 유지한다. `engine.ts:187`에서 ETag 충돌 후 병합한 최종 스냅샷의 대기 항목까지 집계한다. 모든 출처가 실패한 실행은 해설 재시도 성공 여부와 별도로 `failed`를 유지한다. |
| 수집기 저장과 동시 윤문 사이의 ETag 충돌 | 해결 | `engine.ts:58`에서 원문 확인 시각과 해설 편집 시각을 별도로 비교하고, 같은 원문 해시의 최신 완료 해설과 편집 메타데이터를 함께 보존한다. 원문 해시가 달라지면 이전 해설을 가져오지 않는다. 최종 저장과 체크포인트가 모두 같은 병합을 사용한다. |
| 윤문 도구와 다른 편집 도구 사이의 충돌 | 별도 미해결 항목으로 추적 | 최초 검토의 `tools/polish-content.ts:15` 경로는 이번 엔진 수정 범위에 포함되지 않는다. 해당 도구의 별도 수정과 검증이 필요하며, 위 수집기 경로의 해결 판정과 구분한다. |

회귀 테스트 전체 내용을 검토하고, 대표 출처 유지 두 상황, GitHub 승격, 피드에서 빠진 대기 항목 재시도, ETag 재읽기 후 대기 상태 집계, 최종 저장과 체크포인트에서 최신 윤문 보존에 해당하는 **7개만 실행해 모두 통과**했다. 나머지 16개는 실행하지 않았다. 실행 명령은 다음과 같다.

```bash
/tmp/code-pulse-npm-cache/_npx/52027bd8fc0022aa/node_modules/node/bin/node \
  node_modules/vitest/vitest.mjs run tests/engine.test.ts \
  -t 'retains a stored canonical release|promotes an RSS-only release|retries a stored pending release|reports partial if an ETag retry|preserves a newer explanation'
```

이번 재검토 범위의 엔진 세 건에서 남은 결함은 확인하지 못했다. 구현 파일, 운영 데이터와 원격 환경은 변경하지 않았다.

## 2026-10-07 편집 도구 충돌 수정 재검토

**판정: 해결.** 앞선 재검토에서 별도로 남긴 편집 도구 간 충돌을 `tools/editorial-merge.ts`, 수정된 `tools/polish-content.ts`, `tests/editorial.test.ts`로 다시 확인했다.

`tools/editorial-merge.ts:3`은 원문 해시가 같고 편집 시각이 저장된 값보다 엄격하게 더 새로운 결과만 적용한다. 오래된 편집, 같은 시각의 편집, 시각이 없는 편집은 저장된 해설을 유지한다. 원문 해시가 바뀌면 더 늦게 완료된 윤문도 적용하지 않는다. 적용할 때에는 해설, 편집 버전, 편집 시각만 바꾸므로 현재 원문, 공식 출처, 발표일, 확인 시각, 참조 링크와 원문 해설 생성 모델 정보를 보존한다.

`tools/polish-content.ts:16`이 저장 시도마다 이 함수를 사용하고, `tools/polish-content.ts:24`에서 ETag 충돌 후 스냅샷을 다시 읽는 것을 확인했다. 따라서 이전 체크포인트의 편집 결과가 `changes`에 남아 있어도 다른 작업이 저장한 최신 해설을 다시 덮어쓰지 않는다.

테스트 7개의 내용을 읽고, 오래된 편집·같은 시각·시각 누락, 원문 변경 거부, 새 편집 적용 시 원문 필드 보존에 해당하는 **5개만 실행해 모두 통과**했다. 나머지 2개와 다른 테스트 묶음은 실행하지 않았다.

```bash
/tmp/code-pulse-npm-cache/_npx/52027bd8fc0022aa/node_modules/node/bin/node \
  node_modules/vitest/vitest.mjs run tests/editorial.test.ts \
  -t 'preserves the reloaded explanation|rejects a newer edit|applies a newer edit'
```

이로써 최초 검토의 엔진 세 건과 별도 편집 도구 경로는 모두 해결로 판정한다. 이번 검토에서도 보고서 외 파일, 운영 데이터와 AWS 환경은 변경하지 않았다.
