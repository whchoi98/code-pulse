# Full changes implementation plan

> **For agentic workers:** Use subagent-driven-development with isolated task ownership and a final integrated review.

**Goal:** Display and export every official change with Korean explanations, starting with 56/56 items for Claude Code v2.1.293.

**Architecture:** Preserve the existing summary and add versioned fullChanges data. Deterministic extraction defines the inventory; bounded Haiku 5.5 batches fill every ID and are validated before a complete status is allowed.

**Tech Stack:** TypeScript, React, Fastify, Zod, Bedrock Converse, FileStore/S3, existing CDK stack.

**Spec:** docs/superpowers/specs/2026-10-08-full-changes-design.md

## Global constraints

- Node 22 or newer; global.anthropic.claude-haiku-5-5 for generation and polish.
- Preserve source dates, IDs, original bodies, scoped official sources and existing infrastructure.
- No em dashes or middle dots in authored Korean; preserve technical identifiers.
- No source body, sourceHash or model in public fullChanges.
- Every source item must be represented once; no silent source or output cutoff.
- Root owns integration, shared types, versioning, deployment, publication and Git operations. Other workers do not commit.

## Interfaces

```ts
interface FullChangeItem { id: string; text: string }
interface FullChanges {
  status: 'ready' | 'pending';
  sourceHash: string;
  model: string;
  formatVersion: string;
  updatedAt: string;
  sourceCount: number;
  items: FullChangeItem[];
}
type PublicFullChanges = Omit<FullChanges, 'sourceHash' | 'model'>;
interface SourceChangeItem { id: string; section?: string; text: string }
// change-items.ts
function extractChangeItems(candidate: { originalTitle: string; originalText: string }): SourceChangeItem[];
// full-changes.ts
const FULL_CHANGES_VERSION: string;
function fullChangesSourceHash(candidate: { originalTitle: string; originalText: string }): string;
function isFullChangesComplete(value: FullChanges | undefined, candidate: { originalTitle: string; originalText: string }, modelId?: string): boolean;
class BedrockChangeExplainer {
  readonly modelId: string;
  explain(candidate: Candidate, previous?: FullChanges, onProgress?: (value: FullChanges) => Promise<void>): Promise<FullChanges>;
}
```

The sourceHash is SHA-256 of originalTitle + newline + originalText, matching Entry.contentHash. Public APIs and UI use only PublicFullChanges. Optional Entry.fullChanges keeps old snapshots readable.

## Task 1: Source inventory

Files: src/collector/change-items.ts, tests/change-items.test.ts.

- [ ] Write failing cases for 56 bullets, nested/continued lists, code fences, repeated text, narrative paragraphs, heading context and content beyond 30,000 characters.
- [ ] Implement extractChangeItems with stable IDs, original order and no dropped source text.
- [ ] Run npm test -- tests/change-items.test.ts and compare all 56 actual v2.1.293 bullets from the read-only source in /tmp/code-pulse-claude-v2.1.293-original.md.
- [ ] Report count and coverage over the existing 612-record local snapshot without invoking AI or writing production data.

```ts
expect(extractChangeItems({ originalTitle: 'Release', originalText: Array.from({ length: 56 }, (_, i) => `- Change ${i + 1}`).join('\n') })).toHaveLength(56);
```

## Task 2: Full Korean explanations

Files: src/collector/full-changes.ts, tests/full-changes.test.ts.

- [ ] Write failing tests for missing, duplicate and unknown IDs, unchanged-source reuse, changed-source invalidation, long input batching, retry and progress callback failure.
- [ ] Implement source hash and complete-set validation, then generation and a separate polish pass in bounded batches. Resume only validated items for the same source/model/version.
- [ ] Use exact source IDs in model responses, validate Korean text and inline code against the source, reject token-truncated responses and avoid forwarding source instructions.
- [ ] Run npm test -- tests/full-changes.test.ts using injected model responses; no live model calls in unit tests.

```ts
expect(isFullChangesComplete({ ...record, items: record.items.slice(0, -1) }, candidate)).toBe(false);
```

## Task 3: Reader, search and exports

Files: src/client/components.tsx, src/client/styles.css, src/client/lib.ts, src/client/reading.ts, src/client/export.ts, related client tests and tests/browser/full-changes.spec.ts.

- [ ] Write browser regression with 56 items and assert the first and last item are visible and counted.
- [ ] Add the complete numbered list and pending state without hiding the tail; retain the short summary separately.
- [ ] Include full item text in search, read revision and Markdown export; keep timestamps alone from changing read status.
- [ ] Verify mobile 320px, dark mode, keyboard access, pending data, legacy entries, escaping and all exported items.

```ts
await expect(page.locator('.full-change-item')).toHaveCount(56);
await expect(page.locator('.full-change-item').last()).toContainText('마지막 변경');
```

## Task 4: Collector, API and RSS integration

Root files: src/shared/types.ts, src/collector/engine.ts, src/collector/run.ts, src/collector/sources.ts, src/collector/claude-docs.ts, src/server/app.ts, src/server/rss.ts and integration tests.

- [ ] Add shared types and optional fullChanges without exposing private metadata.
- [ ] Write failing engine tests for retaining complete lists, invalidating changed content, retrying old pending records and preserving concurrent publication.
- [ ] Remove 30,000-character source cuts; integrate optional full-list generation into daily collection with the existing time budget.
- [ ] Preserve progress on failure and require full coverage for enabled collection success.
- [ ] Test public privacy, complete RSS items and stale/legacy data behavior.

## Task 5: Migration and acceptance

Root files: tools/backfill-full-changes.ts, tools/verify-full-changes.ts, tools/verify-full-changes-browser.mjs, version/release and affected docs.

- [ ] Implement a resumable local migration with source-hash validation and atomic checkpoint writes, using live Haiku 5.5 only in the explicit migration.
- [ ] Refresh current official discovery and migrate all retained source records; check every extracted ID and the v2.1.293 56/56 case.
- [ ] Advance the compatible application version to 1.2.0 and synchronize release documents.
- [ ] Run changed/full tests, typecheck, build, browser tests and CDK synthesis; request a focused independent review and fix demonstrated issues.
- [ ] Deploy the privacy-aware API and UI before publishing new metadata. Publish with conditional merge and preserve newer source content.
- [ ] Verify the real site, full exports and RSS, canonical host, visitor behavior and fresh collection. Commit, integrate into main and push to the established origin after checks pass.
