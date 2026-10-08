import assert from 'node:assert/strict';
import type { Snapshot } from '../src/shared/types.js';
import { DEFAULT_MODEL_ID, EDITORIAL_VERSION, validateExplanation } from '../src/collector/explanation.js';
import { fullChangesSourceHash, isFullChangesComplete } from '../src/collector/full-changes.js';
import { isOfficialUrl } from '../src/collector/official-fetch.js';
import { SOURCES } from '../src/collector/sources.js';

/** Validate both the incoming data and the final conditional merge before publication. */
export function assertFullPublication(snapshot: Snapshot): void {
  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(snapshot.entries.length > 0, '공개할 기록이 없습니다.');
  assert.equal(new Set(snapshot.entries.map(entry => entry.id)).size, snapshot.entries.length, '중복된 글 ID입니다.');
  assert.deepEqual(snapshot.sources.map(source => source.id).sort(), SOURCES.map(source => source.id).sort());
  assert.ok(snapshot.sources.every(source => source.state === 'ok'), '모든 공식 출처를 확인해야 합니다.');
  assert.equal(snapshot.runs[0]?.status, 'success', '최근 수집이 정상 완료되지 않았습니다.');
  assert.equal(snapshot.runs[0].failedSources.length, 0);
  for (const entry of snapshot.entries) {
    assert.equal(entry.explanationStatus, 'ready', `개요 미완료: ${entry.id}`);
    assert.equal(entry.explanationModel, DEFAULT_MODEL_ID);
    assert.equal(entry.editorialVersion, EDITORIAL_VERSION);
    assert.equal(entry.contentHash, fullChangesSourceHash(entry));
    assert.ok(isFullChangesComplete(entry.fullChanges, entry, DEFAULT_MODEL_ID), `전체 변경 미완료: ${entry.id}`);
    assert.ok(entry.publishedDate >= '2026-01-01' && Date.parse(entry.publishedAt) <= Date.now());
    assert.equal(entry.publishedDate, entry.publishedAt.slice(0, 10));
    assert.ok(isOfficialUrl(entry.sourceUrl) && entry.references.every(reference => isOfficialUrl(reference.url)));
    assert.equal('background' in entry, false);
    validateExplanation(entry.explanation, entry);
  }
}
