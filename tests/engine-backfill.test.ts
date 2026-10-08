import { describe, expect, it, vi } from 'vitest';
import { collectOnce, type CollectOptions } from '../src/collector/engine.js';
import { SOURCES } from '../src/collector/sources.js';
import { emptySnapshot, type SnapshotStore, WriteConflict } from '../src/collector/store.js';
import type { Explanation, Snapshot } from '../src/shared/types.js';

class MemoryStore implements SnapshotStore {
  snapshot = emptySnapshot();
  version = 0;
  writes: Snapshot[] = [];
  beforeNextWrite?: () => Promise<void> | void;
  async read() { return { snapshot: structuredClone(this.snapshot), etag: String(this.version) }; }
  async write(snapshot: Snapshot, etag?: string) {
    const beforeWrite = this.beforeNextWrite;
    this.beforeNextWrite = undefined;
    await beforeWrite?.();
    if (etag !== String(this.version)) throw new WriteConflict();
    this.snapshot = structuredClone(snapshot);
    this.writes.push(structuredClone(snapshot));
    this.version++;
  }
}

const codex = SOURCES.find(source => source.id === 'codex-releases')!;
const claude = SOURCES.find(source => source.id === 'claude-releases')!;
const kiro = SOURCES.find(source => source.id === 'kiro-changelog')!;
const now = () => new Date('2026-10-07T19:00:00Z');
const explanation: Explanation = {
  title: '작업 공간의 접근 범위를 지정합니다',
  summary: '작업 공간의 접근 범위를 지정할 수 있습니다.',
  whyItMatters: '작업에 필요한 디렉터리의 접근 범위를 조정할 수 있습니다.',
  actionItems: ['작업 공간의 접근 설정을 확인하세요.'],
  highlights: [{ title: '작업 공간 설정', detail: '작업 공간의 접근 범위를 지정합니다.', evidence: 'Codex CLI adds workspace controls.' }],
  audience: ['CLI 사용자'], category: 'feature', impact: 'medium',
};
const release = (version: string, publishedAt = '2026-10-07T15:00:00Z') => ({
  tag_name: `rust-v${version}`, name: version, body: 'Codex CLI adds workspace controls.',
  prerelease: false, draft: false, published_at: publishedAt,
  html_url: `${codex.url}/tag/rust-v${version}`,
});
const document = (body: string, url = codex.fetchUrl) => ({ url, body, contentType: 'application/json' });
const releases = (count: number) => JSON.stringify(Array.from({ length: count }, (_, index) => release(`0.${160 + index}.0`)));
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('explicit collection start date', () => {
  it('includes the UTC start instant and now while excluding records on either side', async () => {
    const store = new MemoryStore();
    const run = await collectOnce({
      store, sources: [codex], now, sinceDate: '2026-01-01', lookbackDays: 1, maxSummaries: 0,
      summarize: async () => explanation,
      fetchDocument: async () => document(JSON.stringify([
        release('0.100.0', '2025-12-31T23:59:59.999Z'),
        release('0.101.0', '2026-01-01T00:00:00.000Z'),
        release('0.200.0', '2026-10-07T19:00:00.000Z'),
        release('0.201.0', '2026-10-07T19:00:00.001Z'),
      ])),
    });

    expect(store.snapshot.entries.map(entry => entry.version)).toEqual(['0.200.0', '0.101.0']);
    expect(store.snapshot.entries[1].publishedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(run).toMatchObject({ status: 'partial', newEntries: 2, summarizedEntries: 0 });
  });

  it('accepts a real leap day as an inclusive start date', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [codex], now, sinceDate: '2024-02-29', maxSummaries: 0,
      summarize: async () => explanation,
      fetchDocument: async () => document(JSON.stringify([
        release('0.100.0', '2024-02-28T23:59:59.999Z'), release('0.101.0', '2024-02-29T00:00:00Z'),
      ])),
    });

    expect(store.snapshot.entries.map(entry => entry.version)).toEqual(['0.101.0']);
  });

  it.each(['', '2026-1-01', '2026-02-29', '2026-04-31', '2026-13-01', 'not-a-date', '2026-10-08'])(
    'rejects an invalid or future start date before fetching: %s',
    async sinceDate => {
      const store = new MemoryStore();
      const fetchDocument = vi.fn(async () => document(releases(1)));
      await expect(collectOnce({
        store, sources: [codex], now, sinceDate, fetchDocument, summarize: async () => explanation,
      })).rejects.toThrow(/since|날짜|시작/);

      expect(fetchDocument).not.toHaveBeenCalled();
      expect(store.writes).toHaveLength(0);
    },
  );

  it('retains the generic engine default of a rolling 45-day window', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [codex], now, maxSummaries: 0, summarize: async () => explanation,
      fetchDocument: async () => document(JSON.stringify([
        release('0.101.0', '2026-01-01T00:00:00Z'), release('0.200.0', '2026-10-06T00:00:00Z'),
      ])),
    });

    expect(store.snapshot.entries.map(entry => entry.version)).toEqual(['0.200.0']);
  });
});

describe('bounded parallel explanations', () => {
  it('runs at most three explanations together and shares the remaining summary budget', async () => {
    let active = 0;
    let maximumActive = 0;
    let activeWrites = 0;
    let maximumWrites = 0;
    const summariesDuringWrites: number[] = [];
    class ObservedStore extends MemoryStore {
      async write(snapshot: Snapshot, etag?: string) {
        activeWrites++;
        maximumWrites = Math.max(maximumWrites, activeWrites);
        summariesDuringWrites.push(active);
        try {
          await Promise.resolve();
          await super.write(snapshot, etag);
        } finally { activeWrites--; }
      }
    }
    const store = new ObservedStore();
    const gate = deferred();
    const started: string[] = [];
    const task = collectOnce({
      store, sources: [codex], now, maxSummaries: 5,
      fetchDocument: async () => document(releases(8)),
      summarize: async candidate => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        started.push(candidate.version!);
        try { await gate.promise; return explanation; }
        finally { active--; }
      },
    });
    try {
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
      expect(started).toHaveLength(3);
      expect(active).toBe(3);
      expect(store.writes).toHaveLength(0);
    } finally { gate.release(); await task; }
    const run = await task;

    expect(maximumActive).toBe(3);
    expect(started).toHaveLength(5);
    expect(run).toMatchObject({ status: 'partial', summarizedEntries: 5 });
    expect(store.snapshot.entries.filter(entry => entry.explanationStatus === 'pending')).toHaveLength(3);
    expect(maximumWrites).toBe(1);
    expect(summariesDuringWrites.every(count => count === 0)).toBe(true);
  });

  it('isolates a failed explanation while its parallel neighbors finish', async () => {
    const store = new MemoryStore();
    const gate = deferred();
    const started: string[] = [];
    const warnings: string[] = [];
    const task = collectOnce({
      store, sources: [codex], now, fetchDocument: async () => document(releases(3)),
      onWarning: warning => warnings.push(warning.message),
      summarize: async candidate => {
        started.push(candidate.version!);
        await gate.promise;
        if (candidate.version === '0.161.0') throw new Error('one model request failed');
        return explanation;
      },
    });
    try {
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
      expect(started).toHaveLength(3);
    } finally { gate.release(); await task; }
    const run = await task;

    expect(run).toMatchObject({ status: 'partial', summarizedEntries: 2 });
    expect(store.snapshot.entries.find(entry => entry.version === '0.161.0')?.explanationStatus).toBe('pending');
    expect(store.snapshot.entries.filter(entry => entry.explanationStatus === 'ready')).toHaveLength(2);
    expect(warnings).toEqual(['one model request failed']);
  });

  it('starts no further explanations after the time budget expires with a batch in flight', async () => {
    const store = new MemoryStore();
    const gate = deferred();
    const started: string[] = [];
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const task = collectOnce({
      store, sources: [codex], now, fetchDocument: async () => document(releases(8)),
      summarize: async candidate => {
        started.push(candidate.version!);
        await gate.promise;
        return explanation;
      },
    });
    try {
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
      expect(started).toHaveLength(3);
      wallClock.mockReturnValue(14 * 60_000);
      gate.release();
      const run = await task;

      expect(started).toHaveLength(3);
      expect(run).toMatchObject({ status: 'partial', summarizedEntries: 3 });
      expect(store.snapshot.entries.filter(entry => entry.explanationStatus === 'pending')).toHaveLength(5);
    } finally {
      wallClock.mockReturnValue(14 * 60_000);
      gate.release();
      await task;
      wallClock.mockRestore();
    }
  });

  it('includes all products in the first three explanation slots', async () => {
    const store = new MemoryStore();
    const gate = deferred();
    const products: string[] = [];
    const claudeBody = JSON.stringify([{
      tag_name: 'v2.1.292', name: 'v2.1.292', prerelease: false, draft: false,
      published_at: '2026-10-06T12:00:00Z', html_url: `${claude.url}/tag/v2.1.292`, body: 'Added workspace controls.',
    }]);
    const kiroBody = `<div data-timeline-item><time datetime="2026-10-05"></time><article>
      <a href="/changelog/cli/1-0"><h2>Kiro CLI workspace controls</h2></a>
      <span>1.0.0</span><p>Kiro CLI adds workspace permission controls.</p></article></div>`;
    const task = collectOnce({
      store, sources: [claude, codex, kiro], now, maxSummaries: 3,
      fetchDocument: async url => document(url === claude.fetchUrl ? claudeBody : url === kiro.fetchUrl ? kiroBody : releases(5), url),
      summarize: async candidate => { products.push(candidate.product); await gate.promise; return explanation; },
    });
    try {
      await vi.waitFor(() => expect(products.length).toBeGreaterThan(0));
      expect(products).toEqual(['codex', 'claude-code', 'kiro']);
    } finally { gate.release(); await task; }

    expect((await task).summarizedEntries).toBe(3);
    expect(store.snapshot.entries.filter(entry => entry.explanationStatus === 'ready').map(entry => entry.product).sort())
      .toEqual(['claude-code', 'codex', 'kiro']);
  });

  it('preserves newer editorial edits when a completed parallel refresh batch retries its checkpoint', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [codex], now: () => new Date('2026-10-07T18:00:00Z'), modelId: 'old-model',
      fetchDocument: async () => document(releases(6)), summarize: async () => explanation,
    };
    await collectOnce(options);
    const original = structuredClone(store.snapshot.entries[0]);
    const polished = { ...explanation, title: '동시에 저장된 최신 윤문입니다' };
    store.writes = [];
    store.beforeNextWrite = () => {
      Object.assign(store.snapshot.entries.find(entry => entry.id === original.id)!, {
        explanation: polished, editorialVersion: 'newer-editorial', explanationEditedAt: '2026-10-07T19:01:00.000Z',
      });
      store.version++;
    };
    const run = await collectOnce({
      ...options, now, refreshModel: true, modelId: 'new-model',
      summarize: async () => ({ ...explanation, title: '병렬로 생성한 교체 해설입니다' }),
    });

    expect(run).toMatchObject({ status: 'partial', summarizedEntries: 6 });
    expect(store.writes).toHaveLength(2);
    for (const snapshot of store.writes) {
      expect(snapshot.entries.every(entry => entry.explanationStatus === 'ready')).toBe(true);
      expect(snapshot.entries.find(entry => entry.id === original.id)).toMatchObject({
        explanation: polished, explanationModel: 'old-model', editorialVersion: 'newer-editorial',
        explanationEditedAt: '2026-10-07T19:01:00.000Z',
      });
    }
    expect(store.writes[0].runs.some(item => item.id === run.id)).toBe(false);
  });
});

describe('collection CLI date selection', () => {
  it.each([
    { args: [], versions: ['0.200.0', '0.101.0'], window: { sinceDate: '2026-01-01' } },
    { args: ['--since', '2026-01-01'], versions: ['0.200.0', '0.101.0'], window: { sinceDate: '2026-01-01' } },
    { args: ['--since', '2026-06-01'], versions: ['0.200.0'], window: { sinceDate: '2026-06-01' } },
    { args: ['--days', '90'], versions: ['0.200.0'], window: { days: 90 } },
    { args: ['--days', '365'], versions: ['0.200.0', '0.101.0', '0.100.0'], window: { days: 365 } },
    { args: ['--days', '90', '--since', '2026-01-01'], versions: [], window: undefined },
  ])('selects and logs the requested window: $args', async ({ args, versions, window }) => {
    const store = new MemoryStore();
    const fixture = JSON.stringify([
      release('0.100.0', '2025-12-31T23:59:59Z'), release('0.101.0', '2026-01-01T00:00:00Z'),
      release('0.200.0', '2026-10-06T00:00:00Z'),
    ]);
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('../src/collector/engine.js', () => ({
      collectOnce: (options: CollectOptions) => collectOnce({ ...options, sources: [codex], now }),
    }));
    vi.doMock('../src/collector/explanation.js', () => ({
      BedrockExplainer: class { modelId = 'test-model'; async explain() { return explanation; } },
      EDITORIAL_VERSION: 'test-editorial',
    }));
    vi.doMock('../src/collector/official-fetch.js', async () => ({
      ...await vi.importActual<typeof import('../src/collector/official-fetch.js')>('../src/collector/official-fetch.js'),
      fetchOfficial: async (url: string) => ({ ...document(fixture), url }),
    }));
    vi.doMock('../src/collector/store.js', () => ({ configuredStore: () => store }));
    try {
      process.argv = [process.execPath, 'src/collector/run.ts', '--no-ai', ...args];
      process.exitCode = undefined;
      await import('../src/collector/run.js');

      expect(store.snapshot.entries.map(entry => entry.version)).toEqual(versions);
      if (window) {
        const started = log.mock.calls.map(call => JSON.parse(String(call[0]))).find(event => event.event === 'collection_started');
        expect(started).toMatchObject(window);
        expect(started).not.toHaveProperty('sinceDate' in window ? 'days' : 'sinceDate');
        expect(process.exitCode).toBe(2);
      } else {
        expect(process.exitCode).toBe(1);
        const failed = error.mock.calls.map(call => JSON.parse(String(call[0]))).find(event => event.event === 'collection_failed');
        expect(failed.error).toMatch(/days.*since|since.*days/);
      }
    } finally {
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
      log.mockRestore();
      error.mockRestore();
      vi.doUnmock('../src/collector/engine.js');
      vi.doUnmock('../src/collector/explanation.js');
      vi.doUnmock('../src/collector/official-fetch.js');
      vi.doUnmock('../src/collector/store.js');
      vi.resetModules();
    }
  });
});
