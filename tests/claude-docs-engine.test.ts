import { describe, expect, it, vi } from 'vitest';
import { collectOnce } from '../src/collector/engine.js';
import { SOURCES } from '../src/collector/sources.js';
import { emptySnapshot, type SnapshotStore, WriteConflict } from '../src/collector/store.js';
import type { Explanation, Snapshot } from '../src/shared/types.js';

class MemoryStore implements SnapshotStore {
  snapshot = emptySnapshot();
  version = 0;
  async read() { return { snapshot: structuredClone(this.snapshot), etag: String(this.version) }; }
  async write(snapshot: Snapshot, etag?: string) {
    if (etag !== String(this.version)) throw new WriteConflict();
    this.snapshot = structuredClone(snapshot);
    this.version++;
  }
}

const github = SOURCES.find(source => source.id === 'claude-releases')!;
const changelog = SOURCES.find(source => source.id === 'claude-changelog')!;
const weekly = SOURCES.find(source => source.id === 'claude-whats-new')!;
const now = () => new Date('2026-10-07T22:00:00Z');
const originalText = 'Added plugin evaluation.';
const explanation: Explanation = {
  title: '플러그인을 평가합니다',
  summary: '플러그인 평가 명령이 추가됐습니다.',
  whyItMatters: '플러그인의 동작을 테스트로 확인할 수 있습니다.',
  actionItems: ['플러그인 평가 명령을 확인하세요.'],
  highlights: [{ title: '플러그인 평가', detail: '평가 명령이 추가됐습니다.', evidence: originalText }],
  audience: ['플러그인 개발자'], category: 'feature', impact: 'medium',
};
const weeklyText = '여러 버전에서 제공하는 기능을 한 주 단위로 소개하는 배경 자료입니다.';
const bodies = new Map([
  [github.fetchUrl, JSON.stringify([{
    tag_name: 'v2.1.269', name: 'v2.1.269', prerelease: false, draft: false,
    published_at: '2026-09-11T15:30:00Z',
    html_url: `${github.url}/tag/v2.1.269`, body: originalText,
  }])],
  [changelog.fetchUrl, `<Update label="2.1.269" description="September 11, 2026">
  * ${originalText}
</Update>`],
  [weekly.fetchUrl, `<Update label="Week 37" description="2026년 9월 7–11일" tags={["v2.1.263–v2.1.269"]}>
  ${weeklyText}
  [주간 요약 읽기](/docs/ko/whats-new/2026-w37)
</Update>`],
]);
const fetchDocument = async (url: string) => ({ url, body: bodies.get(url)!, contentType: 'text/markdown' });

describe('Claude documentation collection', () => {
  it('joins all three sources without duplicating a release or storing weekly background text', async () => {
    const store = new MemoryStore();
    const summarize = vi.fn(async () => explanation);
    const run = await collectOnce({
      store, sources: [weekly, changelog, github], now, fetchDocument, summarize,
    });
    expect(run).toMatchObject({ status: 'success', newEntries: 1, summarizedEntries: 1, failedSources: [] });
    expect(store.snapshot.entries).toHaveLength(1);
    expect(store.snapshot.entries[0]).toMatchObject({
      sourceId: github.id, originalText, publishedAt: '2026-09-11T15:30:00.000Z', datePrecision: 'timestamp',
    });
    expect(store.snapshot.entries[0].references.map(reference => reference.url)).toEqual(expect.arrayContaining([
      `${github.url}/tag/v2.1.269`, changelog.url, weekly.url, `${weekly.url}/2026-w37`,
    ]));
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ originalText }), [
      expect.objectContaining({ url: `${weekly.url}/2026-w37`, text: expect.stringContaining(weeklyText) }),
    ]);
    expect(store.snapshot.entries[0]).not.toHaveProperty('background');
    expect(JSON.stringify(store.snapshot)).not.toContain(weeklyText);
    expect(store.snapshot.sources.find(source => source.id === weekly.id)).toMatchObject({ state: 'ok', entryCount: 1 });
    expect(store.snapshot.sources.find(source => source.id === weekly.id)?.latestPublishedDate).toBeUndefined();
  });

  it('accepts a valid weekly overview with no known matching release without inventing a publication', async () => {
    const store = new MemoryStore();
    const summarize = vi.fn(async () => explanation);
    const run = await collectOnce({ store, sources: [weekly], now, fetchDocument, summarize });
    expect(run.status).toBe('success');
    expect(store.snapshot.entries).toHaveLength(0);
    expect(store.snapshot.sources[0]).toMatchObject({ state: 'ok', entryCount: 0 });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('supplies weekly context when refreshing an older stored release outside the discovery window', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [github], now, fetchDocument, modelId: 'old-model', summarize: async () => explanation,
    });
    const originalCheckedAt = store.snapshot.entries[0].checkedAt;
    const summarize = vi.fn(async () => explanation);
    const run = await collectOnce({
      store, sources: [weekly], now: () => new Date('2026-10-07T23:00:00Z'), lookbackDays: 1,
      fetchDocument, summarize, modelId: 'new-model', refreshModel: true,
    });
    expect(run).toMatchObject({ status: 'success', newEntries: 0, summarizedEntries: 1 });
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ originalText }), [
      expect.objectContaining({ text: expect.stringContaining(weeklyText) }),
    ]);
    expect(store.snapshot.entries[0]).toMatchObject({ checkedAt: originalCheckedAt, explanationModel: 'new-model' });
    expect(store.snapshot.entries[0].references.map(reference => reference.url)).toContain(weekly.url);
    expect(store.snapshot.entries[0]).not.toHaveProperty('background');
  });

  it('uses the dated English changelog when GitHub fails and still attaches Korean context', async () => {
    const store = new MemoryStore();
    const summarize = vi.fn(async () => explanation);
    const run = await collectOnce({
      store, sources: [github, changelog, weekly], now, summarize,
      fetchDocument: async url => {
        if (url === github.fetchUrl) throw new Error('HTTP 503');
        return fetchDocument(url);
      },
    });
    expect(run).toMatchObject({ status: 'partial', newEntries: 1, failedSources: [github.id] });
    expect(store.snapshot.entries[0]).toMatchObject({
      sourceId: changelog.id, publishedAt: '2026-09-11T00:00:00.000Z', datePrecision: 'day',
    });
    expect(store.snapshot.entries[0].references.map(reference => reference.url)).toContain(weekly.url);
    expect(summarize).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ text: expect.stringContaining(weeklyText) })]);
  });

  it('records a changed weekly format as a source failure while retaining the primary release', async () => {
    const store = new MemoryStore();
    const run = await collectOnce({
      store, sources: [github, weekly], now, summarize: async () => explanation,
      fetchDocument: async url => url === weekly.fetchUrl
        ? { url, body: '<html>Unexpected page</html>', contentType: 'text/html' } : fetchDocument(url),
    });
    expect(run).toMatchObject({ status: 'partial', newEntries: 1, summarizedEntries: 1, failedSources: [weekly.id] });
    expect(store.snapshot.entries[0]).toMatchObject({ sourceId: github.id, explanationStatus: 'ready' });
  });

  it.each(['2025-12-31T23:30:00Z', '2026-10-08T09:00:00Z'])(
    'does not admit a release through a secondary date when the canonical timestamp %s is outside the period',
    async publishedAt => {
      const store = new MemoryStore();
      const run = await collectOnce({
        store, sources: [changelog, github], now, sinceDate: '2026-01-01', summarize: async () => explanation,
        fetchDocument: async url => {
          const result = await fetchDocument(url);
          if (url !== github.fetchUrl) return result;
          const rows = JSON.parse(result.body);
          rows[0].published_at = publishedAt;
          return { ...result, body: JSON.stringify(rows) };
        },
      });
      expect(run).toMatchObject({ status: 'success', newEntries: 0, summarizedEntries: 0 });
      expect(store.snapshot.entries).toHaveLength(0);
    },
  );
});
