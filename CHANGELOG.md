# Changelog

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

---

# English

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

These entries describe application builds. Git tags and hosted releases are verified separately by the release workflow; no repository URL is assumed.

## [Unreleased]

## [1.1.0] - 2026-10-08

### Added

- Track read articles in the browser and filter unread changes; updated content becomes unread again.
- Navigate to the previous or next record for the same product while preserving the list context.
- Subscribe to the latest 50 Korean explanations through the complete or product-specific RSS feed.
- Export the currently filtered saved articles to Markdown with Korean explanations and official source links.

### Fixed

- Correct the custom domain to code-pulse.whchoi.net, align RSS and visitor origins, and redirect existing CloudFront links.

## [1.0.0] - 2026-10-07

### Added

- Collect official Claude Code, Codex and Kiro changes published from January 1, 2026, including historical releases and dated Kiro patches.
- Generate Korean explanations and a separate editorial pass with Claude Haiku 5.5, preserving source evidence and publication dates.
- Provide product, date and category filters, search, saved articles, shared links, keyboard navigation and dark mode.
- Display official product logos and link Claude Code releases to its English changelog and Korean weekly news.
- Show current and cumulative visitor counts from persistent server data, together with the application version and release notes.
- Run daily collection at 09:00 Asia/Seoul on private Fargate tasks behind the existing VPC, CloudFront and ALB.

---

# 한국어

이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 형식을 바탕으로 작성하며, 프로젝트 버전은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

아래 내용은 앱 빌드의 변경 기록입니다. Git 태그와 원격 릴리스는 릴리스 워크플로에서 별도로 확인하며 저장소 주소를 임의로 만들지 않습니다.

## [Unreleased]

## [1.1.0] - 2026-10-08

### Added

- 브라우저 읽음 기록과 읽지 않은 글 필터 추가, 내용이 바뀐 글 다시 표시
- 목록의 검색 조건을 유지하며 같은 제품의 이전 기록과 다음 기록 탐색
- 전체 또는 제품별 최신 한국어 해설 50개를 받는 RSS 구독 추가
- 현재 조건에 맞는 저장 글의 한국어 해설과 공식 링크를 Markdown으로 내보내기

### Fixed

- code-pulse.whchoi.net 연결 오류 수정, RSS와 방문 집계 주소 통일, 기존 CloudFront 링크의 새 주소 이동

## [1.0.0] - 2026-10-07

### Added

- 2026년 1월 1일부터 발표된 Claude Code, Codex, Kiro의 공식 변경 기록과 날짜가 명시된 Kiro 패치 수집
- Claude Haiku 5.5로 한국어 해설과 별도 윤문을 수행하고 원문 근거와 발표일 보존
- 제품, 날짜, 종류별 필터와 검색, 글 저장, 링크 공유, 키보드 탐색, 다크 모드 추가
- 공식 제품 로고 표시와 Claude Code 영문 changelog 및 한국어 주간 소식 연결
- 서버에 저장한 현재 접속 수와 누적 방문 수, 앱 버전과 서비스 변경 기록 표시
- 기존 VPC의 CloudFront와 ALB 뒤에 프라이빗 Fargate를 배치하고 매일 한국 시간 오전 9시에 수집
