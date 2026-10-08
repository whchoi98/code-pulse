import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectOnce } from '../src/collector/engine.js';
import { readSourceHistory } from '../src/collector/source-history.js';
import { SOURCES, type Candidate, type SourceDefinition } from '../src/collector/sources.js';
import { emptySnapshot, type SnapshotStore, WriteConflict } from '../src/collector/store.js';
import type { Explanation, Snapshot, SourceStatus } from '../src/shared/types.js';

vi.mock('../src/collector/source-history.js', () => ({ readSourceHistory: vi.fn() }));
const reader = vi.mocked(readSourceHistory);
const codex = SOURCES.find(source => source.id === 'codex-releases')!;
const claude = SOURCES.find(source => source.id === 'claude-releases')!;
const codexRss = SOURCES.find(source => source.id === 'codex-changelog')!;
const sinceDate = '2026-01-01';
const sinceTimestamp = '2026-01-01T00:00:00.000Z';
const now = () => new Date('2026-10-07T19:00:00Z');
const recentTimestamp = '2026-08-23T19:00:00.000Z';
const explanation: Explanation = {
  title: '작업 공간의 접근 범위를 지정합니다',
  summary: '작업 공간의 접근 범위를 지정할 수 있습니다.',
  whyItMatters: '작업에 필요한 디렉터리의 접근 범위를 조정할 수 있습니다.',
  actionItems: ['작업 공간의 접근 설정을 확인하세요.'],
  highlights: [{ title: '작업 공간 설정', detail: '작업 공간의 접근 범위를 지정합니다.', evidence: 'Codex CLI adds workspace controls.' }],
  audience: ['CLI 사용자'], category: 'feature', impact: 'medium',
};

class MemoryStore implements SnapshotStore {
  snapshot = emptySnapshot();
  version = 0;
  writes: Snapshot[] = [];
  beforeNextWrite?: () => void;
  rejectFinalWrite = false;
  async read() { return { snapshot: structuredClone(this.snapshot), etag: String(this.version) }; }
  async write(snapshot: Snapshot, etag?: string) {
    const hook = this.beforeNextWrite;
    this.beforeNextWrite = undefined;
    hook?.();
    if (etag !== String(this.version)) throw new WriteConflict();
    if (this.rejectFinalWrite && snapshot.runs.length > this.snapshot.runs.length) throw new Error('final write interrupted');
    this.snapshot = structuredClone(snapshot);
    this.writes.push(structuredClone(snapshot));
    this.version++;
  }
}

function candidate(version: string, publishedAt: string, source = codex): Candidate {
  return {
    product: source.product, sourceId: source.id, channel: 'cli', version, originalTitle: version,
    originalText: 'Codex CLI adds workspace controls.',
    publishedAt, publishedDate: publishedAt.slice(0, 10), datePrecision: 'timestamp',
    sourceUrl: `${source.url}/tag/v${version}`,
    references: [{ title: source.name, url: `${source.url}/tag/v${version}`, kind: 'release' }],
  };
}
function status(historySince?: string, source: SourceDefinition = codex): SourceStatus {
  return {
    id: source.id, product: source.product, name: source.name, url: source.url, state: 'ok', entryCount: 1,
    checkedAt: '2026-10-07T18:00:00.000Z', lastSuccessAt: '2026-10-07T18:00:00.000Z', historySince,
  };
}
const historical = candidate('0.100.0', sinceTimestamp);
const middle = candidate('0.120.0', '2026-06-01T12:00:00.000Z');
const recent = candidate('0.160.0', '2026-10-06T12:00:00.000Z');
const all = [recent, middle, historical];
const options = (store: MemoryStore) => ({
  store, sources: [codex], now, sinceDate,
  fetchDocument: async () => { throw new Error('the reader boundary is replaced for this test'); },
  summarize: async () => explanation,
});
const coverage = (snapshot: Snapshot) => snapshot.sources.find(source => source.id === codex.id)?.historySince;
const readSince = (id = codex.id) => reader.mock.calls.filter(([source]) => source.id === id)
  .map(([, options]) => new Date(options.earliestPublishedAt).toISOString());

beforeEach(() => {
  reader.mockReset();
  reader.mockResolvedValue(all);
});

describe('confirmed Codex history coverage', () => {
  it('confirms the full requested range after storing every source entry even if all explanations remain pending', async () => {
    const store = new MemoryStore();
    const run = await collectOnce({ ...options(store), maxSummaries: 0 });

    expect(run).toMatchObject({ status: 'partial', newEntries: 3, summarizedEntries: 0 });
    expect(readSince()).toEqual([sinceTimestamp]);
    expect(store.snapshot.entries.map(entry => entry.version)).toEqual(['0.160.0', '0.120.0', '0.100.0']);
    expect(store.snapshot.entries.every(entry => entry.explanationStatus === 'pending')).toBe(true);
    expect(coverage(store.snapshot)).toBe(sinceTimestamp);
  });

  it.each([
    { historySince: undefined, requested: sinceDate, expected: sinceTimestamp },
    { historySince: 'not-a-timestamp', requested: sinceDate, expected: sinceTimestamp },
    { historySince: '2026-06-01T00:00:00.000Z', requested: sinceDate, expected: sinceTimestamp },
    { historySince: sinceTimestamp, requested: sinceDate, expected: recentTimestamp },
    { historySince: '2025-12-01T00:00:00.000Z', requested: sinceDate, expected: recentTimestamp },
    { historySince: sinceTimestamp, requested: '2026-09-01', expected: '2026-09-01T00:00:00.000Z' },
  ])('uses a shorter read only for a previously completed requested range: $historySince / $requested', async ({ historySince, requested, expected }) => {
    const store = new MemoryStore();
    store.snapshot.sources = [status(historySince)];
    await collectOnce({ ...options(store), sinceDate: requested, maxSummaries: 0 });

    expect(readSince()).toEqual([expected]);
  });

  it('limits only the Codex GitHub read and keeps the requested eligibility window for returned older records', async () => {
    const store = new MemoryStore();
    store.snapshot.sources = [status(sinceTimestamp), status(sinceTimestamp, claude), status(sinceTimestamp, codexRss)];
    reader.mockImplementation(async source => source.id === codex.id
      ? [recent, middle]
      : [candidate(source.id === claude.id ? '2.1.292' : '0.160.0', recent.publishedAt, source)]);
    await collectOnce({ ...options(store), sources: [codex, claude, codexRss], maxSummaries: 0 });

    expect(readSince()).toEqual([recentTimestamp]);
    expect(readSince(claude.id)).toEqual([sinceTimestamp]);
    expect(readSince(codexRss.id)).toEqual([sinceTimestamp]);
    expect(store.snapshot.entries.find(entry => entry.version === '0.120.0')).toMatchObject({
      sourceId: codex.id, publishedAt: middle.publishedAt, explanationStatus: 'pending',
    });
    expect(coverage(store.snapshot)).toBe(sinceTimestamp);
  });

  it('does not confirm new coverage in intermediate checkpoints', async () => {
    const store = new MemoryStore();
    const rows = [
      ...Array.from({ length: 6 }, (_, index) => candidate(`0.${160 + index}.0`, recent.publishedAt)),
      middle, historical,
    ];
    reader.mockResolvedValue(rows);
    const run = await collectOnce(options(store));

    expect(run).toMatchObject({ status: 'success', newEntries: 8, summarizedEntries: 8 });
    expect(store.writes).toHaveLength(2);
    expect(store.writes[0].entries).toHaveLength(6);
    expect(coverage(store.writes[0])).toBeUndefined();
    expect(store.writes[0].runs.some(item => item.id === run.id)).toBe(false);
    expect(store.writes[1].entries).toHaveLength(8);
    expect(coverage(store.writes[1])).toBe(sinceTimestamp);
  });

  it('rereads the full boundary after a checkpoint-only run loses its final write', async () => {
    const store = new MemoryStore();
    const rows = [
      ...Array.from({ length: 6 }, (_, index) => candidate(`0.${160 + index}.0`, recent.publishedAt)),
      middle, historical,
    ];
    reader.mockImplementation(async (_source, options) => rows.filter(entry => Date.parse(entry.publishedAt) >= options.earliestPublishedAt));
    store.rejectFinalWrite = true;
    await expect(collectOnce(options(store))).rejects.toThrow('final write interrupted');

    expect(store.snapshot.entries).toHaveLength(6);
    expect(coverage(store.snapshot)).toBeUndefined();
    store.rejectFinalWrite = false;
    const retry = await collectOnce({ ...options(store), now: () => new Date('2026-10-07T20:00:00Z') });

    expect(readSince()).toEqual([sinceTimestamp, sinceTimestamp]);
    expect(retry).toMatchObject({ status: 'success', newEntries: 2, summarizedEntries: 2 });
    expect(store.snapshot.entries).toHaveLength(8);
    expect(coverage(store.snapshot)).toBe(sinceTimestamp);
  });

  it('rereads the full boundary after the first history read fails', async () => {
    const store = new MemoryStore();
    reader.mockRejectedValueOnce(new Error('history page failed')).mockResolvedValue(all);
    const failed = await collectOnce(options(store));
    expect(failed.status).toBe('failed');
    expect(coverage(store.snapshot)).toBeUndefined();
    expect(store.snapshot.entries).toHaveLength(0);

    await collectOnce({ ...options(store), now: () => new Date('2026-10-07T20:00:00Z'), maxSummaries: 0 });
    expect(readSince()).toEqual([sinceTimestamp, sinceTimestamp]);
    expect(coverage(store.snapshot)).toBe(sinceTimestamp);
    expect(store.snapshot.entries).toHaveLength(3);
  });

  it('preserves confirmed coverage across errors and later shorter requested ranges', async () => {
    const store = new MemoryStore();
    store.snapshot.sources = [status(sinceTimestamp)];
    reader.mockRejectedValueOnce(new Error('recent page failed'));
    await collectOnce(options(store));

    expect(coverage(store.snapshot)).toBe(sinceTimestamp);
    expect(store.snapshot.sources[0].state).toBe('error');
    reader.mockResolvedValue([recent]);
    await collectOnce({ ...options(store), sinceDate: '2026-09-01', maxSummaries: 0 });

    expect(readSince()).toEqual([recentTimestamp, '2026-09-01T00:00:00.000Z']);
    expect(coverage(store.snapshot)).toBe(sinceTimestamp);
  });

  it('preserves the old confirmed bound at checkpoints and expands it only when the broader range is fully saved', async () => {
    const store = new MemoryStore();
    const previousBound = '2026-06-01T00:00:00.000Z';
    store.snapshot.sources = [status(previousBound)];
    reader.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, index) => candidate(`0.${160 + index}.0`, recent.publishedAt)),
      middle, historical,
    ]);
    await collectOnce(options(store));

    expect(readSince()).toEqual([sinceTimestamp]);
    expect(coverage(store.writes[0])).toBe(previousBound);
    expect(coverage(store.snapshot)).toBe(sinceTimestamp);
  });

  it.each([
    { concurrentBound: '2026-05-01T00:00:00.000Z', expected: sinceTimestamp },
    { concurrentBound: '2025-12-01T00:00:00.000Z', expected: '2025-12-01T00:00:00.000Z' },
  ])('merges confirmed coverage independently of a newer source observation after an ETag conflict: $concurrentBound', async ({ concurrentBound, expected }) => {
    const store = new MemoryStore();
    store.snapshot.sources = [status('2026-06-01T00:00:00.000Z')];
    store.beforeNextWrite = () => {
      store.snapshot.sources[0] = {
        ...status(concurrentBound), state: 'error', checkedAt: '2026-10-07T20:00:00.000Z',
        lastSuccessAt: '2026-10-07T19:30:00.000Z', error: 'a later source check failed',
      };
      store.version++;
    };
    await collectOnce({ ...options(store), maxSummaries: 0 });

    expect(store.snapshot.sources[0]).toMatchObject({
      state: 'error', checkedAt: '2026-10-07T20:00:00.000Z', lastSuccessAt: '2026-10-07T19:30:00.000Z',
      historySince: expected, error: 'a later source check failed',
    });
    expect(store.snapshot.entries).toHaveLength(3);
  });

  it('continues pending retries and model refreshes for old stored releases during recent-only reads', async () => {
    const store = new MemoryStore();
    reader.mockImplementation(async (_source, options) => all.filter(entry => Date.parse(entry.publishedAt) >= options.earliestPublishedAt));
    await collectOnce({ ...options(store), maxSummaries: 0 });
    const original = structuredClone(store.snapshot.entries.find(entry => entry.version === '0.100.0')!);
    const retry = await collectOnce({
      ...options(store), now: () => new Date('2026-10-07T20:00:00Z'), modelId: 'retry-model',
    });
    const refresh = await collectOnce({
      ...options(store), now: () => new Date('2026-10-07T21:00:00Z'), refreshModel: true, modelId: 'new-model',
    });

    expect(readSince()).toEqual([sinceTimestamp, '2026-08-23T20:00:00.000Z', '2026-08-23T21:00:00.000Z']);
    expect(retry).toMatchObject({ status: 'success', summarizedEntries: 3 });
    expect(refresh).toMatchObject({ status: 'success', summarizedEntries: 3 });
    expect(store.snapshot.entries).toHaveLength(3);
    expect(store.snapshot.entries.find(entry => entry.id === original.id)).toMatchObject({
      sourceId: codex.id, originalText: original.originalText, publishedAt: original.publishedAt,
      checkedAt: original.checkedAt, updatedAt: original.updatedAt, explanationModel: 'new-model', explanationStatus: 'ready',
    });
    expect(coverage(store.snapshot)).toBe(sinceTimestamp);
  });
});
