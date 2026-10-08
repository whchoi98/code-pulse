import { describe, expect, it } from 'vitest';
import { applyFullEditorial } from '../tools/full-editorial.js';
import { extractChangeItems } from '../src/collector/change-items.js';
import { FULL_CHANGES_VERSION, fullChangesSourceHash } from '../src/collector/full-changes.js';
import { DEFAULT_MODEL_ID } from '../src/collector/explanation.js';
import { emptySnapshot } from '../src/collector/store.js';
import type { Entry } from '../src/shared/types.js';

function fixture() {
  const source = { originalTitle: 'A release', originalText: '- Fixed `flag` handling.\n- Fixed timing.' };
  const entry: Entry = { ...source, id: 'entry-1', product: 'claude-code', channel: 'cli', sourceId: 'claude-releases',
    sourceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.293', references: [],
    publishedAt: '2026-10-07T18:10:20Z', publishedDate: '2026-10-07', datePrecision: 'timestamp',
    firstSeenAt: '2026-10-08T00:00:00Z', checkedAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z',
    contentHash: fullChangesSourceHash(source), explanationStatus: 'pending',
    fullChanges: { status: 'ready', sourceHash: fullChangesSourceHash(source), model: DEFAULT_MODEL_ID,
      formatVersion: FULL_CHANGES_VERSION, updatedAt: '2026-10-08T00:00:00Z', sourceCount: 2,
      items: extractChangeItems(source).map((item, index) => ({ id: item.id, text: index === 0 ? '`flag` 처리를 수정했습니다.' : '작업 시점을 수정했습니다.' })) },
  };
  const patch = { entryId: entry.id, sourceHash: entry.contentHash, items: [{ id: entry.fullChanges!.items[1].id, text: '작업 전후의 시점 판단을 수정했습니다.' }] };
  return { snapshot: { ...emptySnapshot(), entries: [entry] }, patch };
}

describe('source-bound full-change editing', () => {
  it('changes only the requested generated item and editing clock', () => {
    const { snapshot, patch } = fixture();
    const result = applyFullEditorial(snapshot, [patch], '2026-10-08T09:00:00Z');
    expect(result.entries[0].fullChanges!.items[1].text).toBe(patch.items[0].text);
    expect(result.entries[0].fullChanges!.items[0]).toEqual(snapshot.entries[0].fullChanges!.items[0]);
    expect(result.entries[0].fullChanges!.updatedAt).toBe('2026-10-08T09:00:00Z');
    expect(result.entries[0].publishedAt).toBe(snapshot.entries[0].publishedAt);
    expect(result.entries[0].checkedAt).toBe(snapshot.entries[0].checkedAt);
    expect(snapshot.entries[0].fullChanges!.items[1].text).toBe('작업 시점을 수정했습니다.');
  });
  it('does not advance the edit clock for an identical repeated correction', () => {
    const { snapshot, patch } = fixture();
    const once = applyFullEditorial(snapshot, [patch], '2026-10-08T09:00:00Z');
    expect(applyFullEditorial(once, [patch], '2026-10-08T10:00:00Z')).toEqual(once);
  });
  it('rejects a changed source before editing any item', () => {
    const { snapshot, patch } = fixture();
    expect(() => applyFullEditorial(snapshot, [{ ...patch, sourceHash: 'old-source' }])).toThrow();
    expect(snapshot.entries[0].fullChanges!.items[1].text).toBe('작업 시점을 수정했습니다.');
  });
  it('rejects missing or duplicate target items', () => {
    const { snapshot, patch } = fixture();
    expect(() => applyFullEditorial(snapshot, [{ ...patch, items: [{ id: 'unknown', text: '알 수 없는 항목입니다.' }] }])).toThrow();
    expect(() => applyFullEditorial(snapshot, [{ ...patch, items: [...patch.items, ...patch.items] }])).toThrow();
  });
  it('rejects removal of required source code identifiers', () => {
    const { snapshot, patch } = fixture();
    expect(() => applyFullEditorial(snapshot, [{ ...patch, items: [{ id: snapshot.entries[0].fullChanges!.items[0].id, text: '처리 방식을 수정했습니다.' }] }])).toThrow();
  });
  it('can correct a generated item within valid incomplete progress without inventing the missing item', () => {
    const { snapshot, patch } = fixture();
    snapshot.entries[0].fullChanges!.status = 'pending';
    snapshot.entries[0].fullChanges!.items = [snapshot.entries[0].fullChanges!.items[1]];
    const result = applyFullEditorial(snapshot, [patch]);
    expect(result.entries[0].fullChanges!.status).toBe('pending');
    expect(result.entries[0].fullChanges!.items).toHaveLength(1);
    expect(result.entries[0].fullChanges!.items[0].text).toBe(patch.items[0].text);
  });
});
