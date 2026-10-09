# Static bilingual delivery review

Review date: 2026-10-09. Base: `96e1bb603b2087156273c267451977b1cb9991e5`. Scope: uncommitted tracked and untracked changes in the `static-bilingual` worktree, including the new public-content verifier. Review was read-only; this report is the only authored file.

**Verdict: ready from this code review. No unresolved actionable finding remains.** Three confirmed P2 issues were corrected during review and independently rechecked. No Critical/P1 issue was found. This verdict does not claim that the planned AWS rollout or its production checks have completed.

The publisher protects immutable dependencies, uses generation-aware conditional replacements, preserves older assets, and separates the CloudFront site bucket from private snapshots and visitor storage. The cache retains immutable detail identity and Korean reader revisions across language switches. The reviewed rollout retains the existing web image while provisioning the new origin, then publishes current and legacy assets before enabling S3 routing.

## Findings resolved during review

1. **P2 — Korean RSS navigation could open in the saved English language.** The original implementation omitted `lang=ko` from article and channel links. Corrected in `src/server/rss.ts:36` and `src/server/rss.ts:100`. The final links pin the selected language. The separate GUID handling at `src/server/rss.ts:47` preserves existing Korean subscription identifiers and the existing English form. Independent checks confirmed both languages override an opposite saved preference and retain their previous GUIDs.

2. **P2 — English RSS autodiscovery subscribed readers to Korean.** The original static shell's alternate link remained `/feed.xml` even on an English page, and the runtime language effect did not update it. Corrected in `src/publishing/render.ts:89` and `src/client/i18n.tsx:45`. Independent rendering checks with both real catalogs confirmed `/feed.xml?lang=ko` and `/feed.xml?lang=en`. The runtime effect was inspected and now synchronizes the alternate link whenever language changes. The coordinator owns the added browser regression.

3. **P2 — The content verifier falsely rejected valid search indexes.** The original check lowercased each expected item while retaining case in the index. Corrected in `tools/verify-static-content.ts:48`; both sides now use NFC normalization and lowercase. Independent read-only checks found all 20,428 expected item texts in each real index with the corrected comparison.

## Verification and limits

Independently read every locally published detail in `/tmp/code-pulse-performance/static-site-preview` against the archived public baseline. Both languages contain all 616 record IDs and 20,428 ordered source item IDs. Korean item text is identical to the baseline. Original publication dates, date precision, source URLs and update times match. Every detail filename matches the SHA-256 of its exact bytes; no private raw/hash/model fields appear in catalogs or details. A fresh `git diff --check` passed after the fixes. Focused RSS, static rendering and complete search-coverage reproductions passed after correction.

Inspected publisher concurrency and failure tests, real AWS SDK conditional-storage tests, cache/search/export/read-state tests, browser regressions, CDK controls, build configuration, and operational documentation. Broad unit/browser/build/synth execution remains owned by the implementation coordinator; this review does not claim to have rerun those suites. The coordinator reported 59 focused RSS/publisher tests passing after the fixes. The whole-artifact audit covers the inspected local content payloads; final deployment assets must come from the final validated build.

No AWS mutations or production deployment verification were performed. CloudFront OAC enforcement, missing-page responses, the actual 07:00 schedule, real collector completion, and public performance remain subject to the planned staged deployment checks. Source and published-content validation cannot establish that those operational steps succeeded.

## Scoped follow-up: CloudFront staged rollout

Reviewed the subsequent correction in `infra/lib/stack.ts` and `tests/infra.test.ts`. **No additional actionable finding.**

`CanonicalHost` at `infra/lib/stack.ts:205` now retains exactly the function code from base commit `96e1bb603b2087156273c267451977b1cb9991e5`. The separate `StaticRouter` at `infra/lib/stack.ts:232` is created in the preparation stage. Its code does not depend on `staticRouting`, so the final transition does not republish an already associated function with different routing behavior.

ALB behaviors retain the canonical redirect function. S3 behaviors use the prepared static router through `infra/lib/stack.ts:278`; the default behavior at `infra/lib/stack.ts:288` changes the origin and function association together in the distribution configuration. This removes the earlier rollout sequence in which new rewrite code could reach an edge while its selected default origin was still the legacy ALB. The new staged/final function-code equality assertion at `tests/infra.test.ts:651` checks that the preparation and final configurations contain the same function bodies.

Independent read-only assertions passed for byte-for-byte equality of the old canonical function to the base commit, phase-independent function bodies, unchanged legacy root requests, English detail rewrites, retained API/RSS/health query parameters, invalid-entry 404 responses, and alternate-host redirects. A scoped `git diff --check` passed. No broad suite was repeated, and no AWS deployment was performed. The preparation, artifact upload/verification, and final routing deployment remain separate required operational steps.
