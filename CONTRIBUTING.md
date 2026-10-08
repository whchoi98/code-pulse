# Contributing to Code Pulse

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

### Prepare a change

Read [AGENTS.md](AGENTS.md), [onboarding](docs/onboarding.md) and the guidance for the affected component in the [documentation index](docs/README.md).

1. Describe the problem and the resulting user behavior.
2. Change the relevant source and documentation while preserving unrelated work and historical release entries.
3. Run the applicable checks below and record what actually ran.
4. Hand off the changed paths, validation results and remaining limitations in a pull request.

The repository is [whchoi98/code-pulse](https://github.com/whchoi98/code-pulse), and the primary branch is `main`. Report problems in [Issues](https://github.com/whchoi98/code-pulse/issues). No license file or separate public contact email is specified.

1. Fork the repository, or use your existing write access.
2. Create a branch from the current `main`.
3. Commit the change with a concrete message such as `fix: preserve RSS publication dates`.
4. Push the branch to your fork or the authorized repository.
5. Open a pull request against `main` with the relevant verification results.

### Choose verification

| Change | Verification |
| --- | --- |
| Prose or links | Review facts and local targets; check language parity for bilingual documents |
| Version-bearing documentation | Run `npm run release:check` |
| Generator or executable example | Check the affected generator or example in a local environment |
| Implementation behavior | Run `npm run typecheck`, `npm test` and the relevant `npm run test:browser` checks required by AGENTS.md |
| Infrastructure | Also run `npm run synth -- --no-lookups` and review the actual template changes |
| Release and deployment | Follow the [version workflow](docs/versioning.md), [runbook](docs/runbook.md) and deployment checks |

Reuse earlier implementation results only when the relevant source, tests, dependencies and configuration still match. State which results are reused. A prose-only edit does not require another application test run. Existing full-suite and deployment requirements still apply to the changes they cover.

### Maintain the documentation

Keep the Korean README in its existing layout. New public guides use English followed by Korean, matching language badges, equivalent commands and the same technical values. Polish changed Korean prose without changing facts, code or source quotations. Avoid em dashes, middle dots and decorative emoji.

Update [architecture](docs/architecture.md) for changes in component responsibilities, [API reference](docs/reference/api.md) for contract changes, and [onboarding](docs/onboarding.md) or the [runbook](docs/runbook.md) for operational changes. Preserve dated reports as historical evidence.

`package.json.version` is authoritative. `src/shared/app-release.json` supplies the bilingual release notes. Use `npm run release:sync` for generated files; do not manually alter released history. Documentation preparation alone does not change the version or publish a tag.

### Work with data

Use local files and controlled fixtures for development. Collection and editorial tools can invoke the model or write S3 when configured for AWS; read the runbook and verify the intended store before those operations. Do not copy credentials, origin header values or visitor cookies into reports. Preserve stable IDs, publication dates, conditional writes and the separation between web and collector permissions.

## 한국어

### 변경 준비

[AGENTS.md](AGENTS.md), [개발 시작 안내](docs/onboarding.md)와 [문서 목차](docs/README.md)의 관련 구성 요소 안내를 읽습니다.

1. 해결할 문제와 변경 후 사용자에게 보이는 동작을 설명합니다.
2. 관련 소스와 문서를 수정하고 다른 작업과 과거 릴리스 기록은 보존합니다.
3. 아래에서 필요한 검사를 실행하고 실제 수행한 내용을 기록합니다.
4. 바뀐 경로, 검증 결과와 남은 제약을 Pull Request에 기록합니다.

저장소는 [whchoi98/code-pulse](https://github.com/whchoi98/code-pulse)이며 기본 브랜치는 `main`입니다. 문제는 [Issues](https://github.com/whchoi98/code-pulse/issues)에 등록합니다. 라이선스 파일과 별도 공개 연락처 이메일은 지정되지 않았습니다.

1. 저장소를 fork하거나 기존 쓰기 권한을 사용합니다.
2. 최신 `main`에서 작업 브랜치를 만듭니다.
3. `fix: preserve RSS publication dates`처럼 변경을 설명하는 메시지로 커밋합니다.
4. 자신의 fork나 승인된 저장소에 브랜치를 푸시합니다.
5. 필요한 검증 결과와 함께 `main`을 대상으로 Pull Request를 엽니다.

### 검증 범위

| 변경 | 검증 |
| --- | --- |
| 문장과 링크 | 사실과 로컬 경로 확인, 이중 언어 문서의 의미 대조 |
| 버전이 들어 있는 문서 | `npm run release:check` 실행 |
| 생성기와 실행 예제 | 해당 생성기나 예제를 로컬 환경에서 확인 |
| 구현 동작 | AGENTS.md에 따라 `npm run typecheck`, `npm test`와 관련 `npm run test:browser` 검사 실행 |
| 인프라 | `npm run synth -- --no-lookups`를 추가로 실행하고 실제 템플릿 변경 확인 |
| 릴리스와 배포 | [버전 정책](docs/versioning.md), [운영 안내](docs/runbook.md)와 배포 검사 적용 |

이전 구현 검사 결과는 관련 소스, 테스트, 의존성과 설정이 같을 때만 재사용하고 그 사실을 밝힙니다. 문장만 고쳤다면 앱 테스트를 다시 실행할 필요는 없습니다. 전체 검사와 배포 검증이 필요한 변경에는 기존 필수 절차를 그대로 적용합니다.

### 문서 관리

한국어 README의 기존 구성을 유지합니다. 새 공개 안내는 영어 뒤에 한국어를 배치하고, 언어 배지와 명령, 기술 값을 서로 맞춥니다. 한국어 문장을 다듬을 때 사실, 코드와 원문 인용은 보존합니다. 엠대시, 가운뎃점과 장식용 이모지는 사용하지 않습니다.

구성 요소의 역할이 달라지면 [아키텍처](docs/architecture.md)를, 계약이 달라지면 [API 참조](docs/reference/api.md)를 갱신합니다. 운영 방식이 바뀌면 [개발 시작 안내](docs/onboarding.md)나 [운영 안내](docs/runbook.md)를 수정합니다. 날짜가 있는 보고서는 과거 근거로 보존합니다.

버전 기준은 `package.json.version`입니다. `src/shared/app-release.json`에서 양 언어의 릴리스 노트를 관리하고, 생성 파일은 `npm run release:sync`로 갱신합니다. 공개된 과거 기록을 직접 고치지 않습니다. 문서 준비만으로 버전을 올리거나 태그를 공개하지 않습니다.

### 데이터 작업

개발에는 로컬 파일과 정해진 테스트 자료를 사용합니다. AWS 설정이 있는 수집과 편집 도구는 모델을 호출하거나 S3를 갱신할 수 있으므로 실행 전에 운영 안내와 대상 저장소를 확인합니다. 자격 증명, 원본 헤더 값과 방문 쿠키를 보고서에 복사하지 않습니다. 글 ID와 발표일, 조건부 쓰기, 웹과 수집기의 권한 분리를 유지합니다.
