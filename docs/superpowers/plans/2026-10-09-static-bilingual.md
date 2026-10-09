# Static Bilingual Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $subagent-driven-development or $executing-plans to implement this plan task-by-task.

**Goal:** Deliver complete Korean and English releases quickly from S3, prefetch nearby details and collect daily at 07:00 KST.

**Architecture:** Pre-render pages and publish compact catalogs plus immutable complete details through private S3 and CloudFront. Preserve the existing visitor backend and legacy API. Render English official items without additional model generation.

**Tech Stack:** TypeScript, React, Fastify, AWS SDK v3, CDK, S3, CloudFront, Fargate.

**Spec:** [Design](2026-10-09-static-bilingual-design.md)

## Global Constraints

- Node >=22, no VPC/subnet/NAT changes, no additional custom CloudFront cache policy.
- Keep all source item IDs and counts, original publication dates, source failure preservation and private model/hash fields.
- Existing Korean API remains compatible; source English and AI Korean are clearly labeled.
- 07:00 Asia/Seoul; manifest version 1.3.0; no tag or hosted release.
- No authored Korean em dashes or middle dots.

## Task 1: Static publisher and bilingual content

Files: `src/publishing/`, `src/shared/types.ts`, `src/collector/run.ts`, `tools/publish-site.ts`, publication tests.
Interfaces: `publishConfiguredSite(store: SnapshotStore): Promise<PublicationReport | undefined>`; site bucket from `SITE_BUCKET`, build files from `STATIC_DIR`; local publication via `SITE_DIR`. Follow the delivery contract in the design.

- [x] Write and run failing tests asserting every source ID appears in English and Korean output, compact feed omits item text, and private raw/hash/model fields never occur.
- [x] Implement the public bilingual projection, complete lazy search index and content-addressed detail objects.
- [x] Test and implement pre-rendering with safely escaped bootstrap data and existing query links.
- [x] Test and implement dependency-first publication, concurrency protection, idempotent immutable uploads, failure preservation and collector final-publication integration.
- [x] Add the explicit local/S3 publication CLI and verify against current production data.

## Task 2: Language-aware interface

Files: `src/client/i18n.tsx`, `App.tsx`, `components.tsx`, `footer.tsx`, `subscriptions.tsx`, `export.ts`, UI tests.
Interfaces: shared `Language`; page language from explicit URL, persisted preference then ko; use English `contentKind: source` to hide AI-only sections and label full source inventory correctly.

- [x] Write and run failing browser tests for English toggle, persistence, URL sharing, full English detail and mobile controls.
- [x] Implement bilingual controls, notices, source labels and counts with a central locale helper.
- [x] Preserve existing Korean selectors, source links, dates, saved/read state and modals.
- [x] Add English RSS/export and release-note language with aligned meaning.
- [x] Verify both languages with real complete records, unavailable states and mobile layout.

## Task 3: Demand loading and cache

Files: `src/client/remote-cache.ts`, `hooks.ts`, `reading.ts`, `lib.ts`, `main.tsx`, demand-loading tests.
Interfaces: `/content/{language}/feed.json`, immutable `detailUrl`, complete `searchUrl`, escaped bootstrap template. Expose `useFeed(language)`, `useDetail(entryId, feed, language)`, `useSearchIndex(feed, query)` and `useViewportPrefetch(feed, visibleIds)` to App; expose detail resolution for saved export. Coordinate App integration with its owner.

- [x] Write and run failing tests for coalescing, immutable URL invalidation, bounded viewport prefetch and instant cached navigation.
- [x] Implement bootstrap seeding, bounded request/cache layers, catalog refresh and current metadata merge.
- [x] Keep complete text search lazy; show its loading/error state and retain complete result semantics.
- [x] Resolve every selected saved detail before export and preserve read-state fingerprints across languages.
- [x] Test deep links, retries, abandoned requests, offline cache, revised records and language changes.

## Task 4: Infrastructure, integration and delivery

Files: `infra/lib/stack.ts`, `infra/bin/app.ts`, `Dockerfile`, `tools/build.mjs`, server RSS, package/release docs, operational docs and production evidence.

- [x] Measure current production payload and browser paint/detail navigation.
- [x] Add failing CDK tests for private S3 OAC, unchanged presence route, stable single cache policy and cron(0 7 * * ? *).
- [x] Implement staged static routing and correct cache/security headers, least-privilege publication IAM and outputs.
- [x] Integrate all parts; run typecheck, meaningful unit and full browser regressions, build, synth and release checks.
- [x] Provision with static routing disabled, publish and validate artifacts, then enable S3 routing.
- [x] Run and observe the actual collector publication to completion; verify scheduled task settings.
- [x] Verify coverage of all records, both languages, rendered HTML without JavaScript, request/caching bounds, publication updates, RSS, saved export, privacy, counts, 404s and measured performance.
- [x] Complete the Git handoff and confirm remote CI after the already verified deployment.

## Execution record before Git handoff

2026-10-09: Tasks 1–3 implemented in the isolated worktree. Independent review verified both 616-record / 20,428-item inventories, private fields, dates and asset hashes. Three P2 findings (RSS language links, RSS autodiscovery and verifier case comparison) were corrected with focused passing checks. Baseline whole regression:653 unit/infrastructure tests and97 browser tests; added RSS regressions pass. A concurrent CDK synthesis caused a Vite development-page reload during one browser retry test; the unchanged test passed when synthesis completed.

The rollout uses a separate pre-created StaticRouter function so association and S3 origin change in one distribution configuration. A regression proves prepared and final function code are identical. AWS preparation, publication and S3 cutover completed. Production checks passed; the real collector completed successfully and republished generation 2 while reusing all 1,385 immutable objects. Final typecheck and all 655 unit/infrastructure tests passed. Git handoff is the remaining step.

## Git handoff confirmation

On 2026-10-09, commit `c73ab657d6e59663e4fe847365cf84b917a2955d` was merged into `main` and pushed to `whchoi98/code-pulse`. GitHub Actions run `37872098732` completed successfully at `2026-10-09T01:56:42Z`. It verified release consistency, types, tests, build and runtime dependency audit. The tag-only `publish-notes` job was skipped. This completes the handoff that was still pending in the record above; it did not create a tag or hosted release.
