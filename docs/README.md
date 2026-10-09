# Code Pulse documentation

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

Start with the [project overview](../README.md) and [contributor instructions](../AGENTS.md). These guides describe the current source; dated verification and implementation reports preserve observations from their own runs.

### Development and operations

| Task | Document |
| --- | --- |
| Install and run locally | [Onboarding](onboarding.md) |
| Understand components and data ownership | [Architecture](architecture.md) |
| Read the HTTP and RSS contracts | [API reference](reference/api.md) |
| Propose and verify a change | [Contributing](../CONTRIBUTING.md) |
| Operate collection, presence and the custom domain | [Runbook](runbook.md), currently in Korean |
| Publish static pages, inspect caching and preview both languages | [Static delivery](static-delivery.md) |
| Maintain versions and release notes | [Version workflow](versioning.md) |
| Inspect application build history | [Changelog](../CHANGELOG.md) and the release links in the project overview |
| Inspect static delivery, language and loading evidence | [v1.3.0 verification](verification.md#v130-정적-배포와-영어-지원) |
| Inspect deployment evidence | [Verification](verification.md), currently in Korean |
| Inspect complete-change coverage | [v1.3.0 source inventory](full-changes-v1.3.0-verification.json), [both public languages](static-content-verification.json) |
| Check logo provenance | [Brand sources](../public/brand/SOURCES.md) |

### Historical context

The [initial design](superpowers/specs/2026-10-07-code-pulse-design.md), [implementation plan](superpowers/plans/2026-10-07-code-pulse.md), [progress notes](progress.md) and [infrastructure report](infra-report.md) explain earlier decisions and investigation. Their task lists, model settings, URLs and test counts may describe older stages. Use current source and the latest section of the verification document for present behavior.

The [RSS implementation notes](rss-implementation.md), [initial final review](final-review.md), [v1.2.0 inventory](full-changes-verification.json) and [Korean content review](full-changes-content-review.json) preserve earlier evidence. The [v1.3.0 review](static-delivery-review.md) covers static delivery and language support. Do not replace dated reports with a new test result; add the new result to the document that owns the verification.

## 한국어

[프로젝트 소개](../README.md)와 [기여자 지침](../AGENTS.md)부터 읽습니다. 개발 안내는 현재 소스를 설명하며, 날짜가 있는 검증과 구현 보고서는 해당 작업에서 확인한 내용을 보존합니다.

### 개발과 운영

| 목적 | 문서 |
| --- | --- |
| 설치와 로컬 실행 | [개발 시작 안내](onboarding.md) |
| 구성 요소와 데이터 관리 주체 이해 | [아키텍처](architecture.md) |
| HTTP와 RSS 계약 확인 | [API 참조](reference/api.md) |
| 변경 제안과 검증 | [기여 안내](../CONTRIBUTING.md) |
| 수집, 방문 집계와 도메인 운영 | [운영 안내](runbook.md), 한국어 문서 |
| 정적 발행, 캐시와 두 언어 미리보기 | [정적 배포 안내](static-delivery.md) |
| 버전과 릴리스 노트 관리 | [버전 정책](versioning.md) |
| 앱 빌드 이력 확인 | [변경 기록](../CHANGELOG.md)과 프로젝트 소개의 릴리스 링크 |
| 정적 배포, 언어와 로딩 검증 | [v1.3.0 검증](verification.md#v130-정적-배포와-영어-지원) |
| 배포 검증 근거 확인 | [검증 기록](verification.md), 한국어 문서 |
| 전체 변경 항목의 포함 여부 확인 | [v1.3.0 원문 항목](full-changes-v1.3.0-verification.json), [두 언어 공개 데이터](static-content-verification.json) |
| 로고 출처 확인 | [브랜드 자료](../public/brand/SOURCES.md) |

### 과거 작업 기록

[초기 설계](superpowers/specs/2026-10-07-code-pulse-design.md), [구현 계획](superpowers/plans/2026-10-07-code-pulse.md), [진행 기록](progress.md), [인프라 보고서](infra-report.md)에는 이전 결정과 조사 과정이 남아 있습니다. 작업 목록과 모델 설정, 주소, 테스트 수는 당시 상태를 설명할 수 있습니다. 현재 동작은 소스 코드와 검증 문서의 최신 항목을 기준으로 확인합니다.

[RSS 구현 기록](rss-implementation.md), [초기 최종 검토](final-review.md), [v1.2.0 항목 검증](full-changes-verification.json)과 [한국어 내용 대조](full-changes-content-review.json)는 당시의 근거를 보존합니다. 정적 배포와 영어 지원은 [v1.3.0 검토](static-delivery-review.md)에서 확인합니다. 새 검증 결과는 해당 검증을 관리하는 문서에 추가하고, 날짜가 있는 과거 보고서는 보존합니다.
