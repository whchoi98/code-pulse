import { describe, expect, it } from 'vitest';
import { assertFullPublication } from '../tools/full-publication.js';
import { extractChangeItems } from '../src/collector/change-items.js';
import { fullChangesSourceHash, FULL_CHANGES_VERSION } from '../src/collector/full-changes.js';
import { DEFAULT_MODEL_ID, EDITORIAL_VERSION } from '../src/collector/explanation.js';
import { SOURCES } from '../src/collector/sources.js';
import { emptySnapshot } from '../src/collector/store.js';
import type { Entry, Snapshot } from '../src/shared/types.js';
function fixture(): Snapshot {
  const source = { originalTitle: 'Release', originalText: '- Added a stable setting for command execution.' };
  const entry: Entry = { ...source, id: 'entry-1', product: 'claude-code', channel: 'cli', sourceId: 'claude-releases',
    sourceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.293', references: [],
    publishedAt: '2026-10-07T18:10:20Z', publishedDate: '2026-10-07', datePrecision: 'timestamp',
    firstSeenAt: '2026-10-08T00:00:00Z', checkedAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z',
    contentHash: fullChangesSourceHash(source), explanationStatus: 'ready', explanationModel: DEFAULT_MODEL_ID, editorialVersion: EDITORIAL_VERSION,
    explanation: { title: '명령 실행 설정을 추가했습니다', summary: '명령 실행 설정을 추가했습니다.', whyItMatters: '명령 실행 조건을 확인할 수 있습니다.', actionItems: ['명령 실행 설정을 확인하세요.'], highlights: [{ title: '실행 설정', detail: '안정적인 실행 설정을 추가했습니다.', evidence: 'Added a stable setting' }], audience: ['도구 사용자'], category: 'feature', impact: 'medium' },
    fullChanges: { status: 'ready', sourceHash: fullChangesSourceHash(source), model: DEFAULT_MODEL_ID, formatVersion: FULL_CHANGES_VERSION,
      updatedAt: '2026-10-08T00:00:00Z', sourceCount: 1, items: extractChangeItems(source).map(item => ({ id: item.id, text: '명령 실행에 안정적인 설정을 추가했습니다.' })) },
  };
  return { ...emptySnapshot(), entries: [entry],
    sources: SOURCES.map(source => ({ id: source.id, product: source.product, name: source.name, url: source.url, state: 'ok', entryCount: 1 })),
    runs: [{ id: 'run-1', startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:01:00Z', status: 'success', newEntries: 1, updatedEntries: 0, summarizedEntries: 1, failedSources: [] }],
  };
}
describe('publication coverage gate', () => {
  it('accepts verified full coverage with healthy sources', () => expect(() => assertFullPublication(fixture())).not.toThrow());
  it('rejects a ready overview without its full list', () => {
    const value = fixture(); delete value.entries[0].fullChanges;
    expect(() => assertFullPublication(value)).toThrow();
  });
  it('rejects a newer merged record whose full list is incomplete', () => {
    const value = fixture(); value.entries[0].fullChanges!.status = 'pending'; value.entries[0].fullChanges!.items = [];
    expect(() => assertFullPublication(value)).toThrow();
  });
  it('rejects a failed source or partial latest collection', () => {
    const value = fixture(); value.sources[1].state = 'error';
    expect(() => assertFullPublication(value)).toThrow();
    value.sources[1].state = 'ok'; value.runs[0].status = 'partial';
    expect(() => assertFullPublication(value)).toThrow();
  });
  it('rejects a mismatched source hash and duplicate entry IDs', () => {
    const value = fixture(); value.entries[0].contentHash = 'stale';
    expect(() => assertFullPublication(value)).toThrow();
    const duplicate = fixture(); duplicate.entries.push(structuredClone(duplicate.entries[0]));
    expect(() => assertFullPublication(duplicate)).toThrow();
  });
});
