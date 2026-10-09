import { describe, expect, it } from 'vitest';
import { filterEntries, getCollectionState, readLocation } from '../src/client/lib';
import type { Feed, FeedEntry } from '../src/shared/types';
import { fullChangesFixture } from './fixtures/full-changes';

const entry: FeedEntry = {
  id: 'full-list', product: 'claude-code', channel: 'cli', sourceId: 'test-release', version: 'test-version',
  originalTitle: 'Synthetic changes', publishedAt: '2026-10-07T00:00:00Z', publishedDate: '2026-10-07',
  datePrecision: 'timestamp', sourceUrl: 'https://github.com/anthropics/claude-code/releases', references: [],
  firstSeenAt: '2026-10-07T00:00:00Z', checkedAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
  explanationStatus: 'ready', explanation: {
    title: '작업 공간 개선', summary: '작업 공간의 여러 오류를 고쳤습니다.', whyItMatters: '기존 설정을 유지합니다.',
    highlights: [], actionItems: [], audience: [], category: 'fix', impact: 'low',
  }, fullChanges: fullChangesFixture(),
};

describe('search across full changes', () => {
  it('finds the final item through the separately loaded complete index', () => {
    const compact = { ...entry, fullChanges: undefined, searchText: '마지막 변경 잔여세션정리 오류를 고쳤습니다.' };
    expect(filterEntries([compact], { ...readLocation(''), query: '잔여세션정리' }, []).map(item => item.id)).toEqual(['full-list']);
  });
  it('finds a keyword that appears only in item 56', () => {
    expect(filterEntries([entry], { ...readLocation(''), query: '잔여세션정리' }, []).map(item => item.id)).toEqual(['full-list']);
    expect(filterEntries([{ ...entry, fullChanges: undefined }], { ...readLocation(''), query: '잔여세션정리' }, [])).toEqual([]);
  });

  it('finds available pending items while preserving product, saved, and unread filters', () => {
    const pending = { ...entry, fullChanges: fullChangesFixture({ status: 'pending' }) };
    const filters = readLocation('?product=claude-code&saved=1&unread=1&q=잔여세션정리');
    expect(filterEntries([pending], filters, ['full-list'], () => false).map(item => item.id)).toEqual(['full-list']);
    expect(filterEntries([pending], filters, [], () => false)).toEqual([]);
    expect(filterEntries([pending], filters, ['full-list'], () => true)).toEqual([]);
    expect(filterEntries([pending], { ...filters, product: 'codex' }, ['full-list'], () => false)).toEqual([]);
  });

  it('normalizes full-list search text without exposing private metadata', () => {
    const source = { ...entry, fullChanges: fullChangesFixture({ sourceCount: 1, items: [{ id: 'private-item-id', text: '설정 ABC 옵션을 확인하세요.'.normalize('NFD') }] }) };
    expect(filterEntries([source], { ...readLocation(''), query: '설정 abc' }, [])).toHaveLength(1);
    for (const query of ['PRIVATE_FULL_MODEL', 'PRIVATE_FULL_SOURCE_HASH', 'private-item-id']) {
      expect(filterEntries([source], { ...readLocation(''), query }, [])).toEqual([]);
    }
  });
});

const pendingCases = [
  { name: 'a compact catalog with an unfinished inventory', pending: true,
    overrides: { fullChanges: undefined, changeSummary: { status: 'pending', sourceCount: 56, readyCount: 4 } } },
  { name: 'a compact catalog with ready but incomplete inventory', pending: true,
    overrides: { fullChanges: undefined, changeSummary: { status: 'ready', sourceCount: 56, readyCount: 55 } } },
  { name: 'a compact catalog with a complete inventory', pending: false,
    overrides: { fullChanges: undefined, changeSummary: { status: 'ready', sourceCount: 56, readyCount: 56 } } },
  { name: 'a ready summary with a pending full list', pending: true,
    overrides: { fullChanges: fullChangesFixture({ status: 'pending', items: fullChangesFixture().items.slice(0, 4) }) } },
  { name: 'a full list still pending after all items are present', pending: true,
    overrides: { fullChanges: fullChangesFixture({ status: 'pending' }) } },
  { name: 'a ready full list missing its final item', pending: true,
    overrides: { fullChanges: fullChangesFixture({ items: fullChangesFixture().items.slice(0, 55) }) } },
  { name: 'a full list with duplicate item IDs', pending: true,
    overrides: { fullChanges: fullChangesFixture({ items: Array.from({ length: 56 }, () => ({ id: 'duplicate', text: '설정을 유지합니다.' })) }) } },
  { name: 'an empty full inventory marked ready', pending: true,
    overrides: { fullChanges: fullChangesFixture({ sourceCount: 0, items: [] }) } },
  { name: 'a complete full list and ready summary', pending: false, overrides: {} },
  { name: 'a complete full list with a pending summary', pending: true,
    overrides: { explanationStatus: 'pending', explanation: undefined } },
  { name: 'a ready legacy summary without a full list', pending: false,
    overrides: { fullChanges: undefined } },
  { name: 'a pending legacy summary without a full list', pending: true,
    overrides: { explanationStatus: 'pending', explanation: undefined, fullChanges: undefined } },
] satisfies { name: string; pending: boolean; overrides: Partial<FeedEntry> }[];

describe('pending explanation tracking', () => {
  it('becomes stale as source checks age even when the serialized stale flag was false', () => {
    const source = { ...entry };
    const old: Feed = { generatedAt: '2026-01-01T00:00:00Z', entries: [source],
      sources: [{ id: 'test-release', product: 'claude-code', name: 'Synthetic source', url: source.sourceUrl,
        state: 'ok', entryCount: 1, lastSuccessAt: '2026-01-01T00:00:00Z' }],
      schedule: { timezone: 'Asia/Seoul', hour: 7 }, stale: false };
    expect(getCollectionState(old).oldData).toBe(true);
  });
  it.each(pendingCases)('reports collection readiness for $name', ({ pending, overrides }) => {
    const source = { ...entry, ...overrides };
    const feed: Feed = {
      generatedAt: '2026-10-07T00:00:00Z', entries: [source],
      sources: [{ id: 'test-release', product: 'claude-code', name: 'Synthetic source',
        url: source.sourceUrl, state: 'ok', entryCount: 1, lastSuccessAt: '2026-10-07T00:00:00Z' }],
      schedule: { timezone: 'Asia/Seoul', hour: 9 }, stale: false,
    };
    expect(getCollectionState(feed).pendingExplanations).toBe(pending);
  });

  it.each(pendingCases)('applies the pending filter to $name', ({ pending, overrides }) => {
    const source = { ...entry, ...overrides };
    const filtered = filterEntries([source], readLocation('?category=pending'), []);
    expect(filtered.map(item => item.id)).toEqual(pending ? ['full-list'] : []);
  });
});
