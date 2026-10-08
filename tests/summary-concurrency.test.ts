import { describe, expect, it, vi } from 'vitest';
import { collectOnce, type CollectOptions } from '../src/collector/engine.js';
import { emptySnapshot, WriteConflict, type SnapshotStore } from '../src/collector/store.js';
import type { Candidate, SourceDefinition } from '../src/collector/sources.js';
import type { Explanation, Snapshot } from '../src/shared/types.js';
import { extractChangeItems } from '../src/collector/change-items.js';
import { FULL_CHANGES_VERSION, fullChangesSourceHash } from '../src/collector/full-changes.js';

const source: SourceDefinition = {
  id: 'claude-releases', product: 'claude-code', name: 'Claude Code 공식 릴리스',
  url: 'https://github.com/anthropics/claude-code/releases',
  fetchUrl: 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=100', parser: 'github',
};
const explanation: Explanation = {
  title: '작업 실행 수를 조절합니다', summary: '실행 수 설정을 추가했습니다.',
  whyItMatters: '필요한 처리량을 지정할 수 있습니다.', actionItems: ['설정값을 확인하세요.'],
  highlights: [{ title: '실행 수 설정', detail: '동시 실행 수를 지정합니다.', evidence: 'Added bounded worker settings.' }],
  audience: ['개발자'], category: 'feature', impact: 'medium',
};
const body = JSON.stringify(Array.from({ length: 13 }, (_, index) => ({
  tag_name: `v2.1.${100 + index}`, name: `2.1.${100 + index}`, prerelease: false, draft: false,
  published_at: '2026-10-06T12:00:00Z', html_url: `${source.url}/tag/v2.1.${100 + index}`,
  body: 'Added bounded worker settings.',
})));
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

class MemoryStore implements SnapshotStore {
  snapshot = emptySnapshot();
  version = 0;
  reads = 0;
  writes: Snapshot[] = [];
  writeSummaryCounts: number[] = [];
  activeWrites = 0;
  maximumWrites = 0;
  constructor(private readonly activeSummaries: () => number) {}
  async read() { this.reads++; return { snapshot: structuredClone(this.snapshot), etag: String(this.version) }; }
  async write(snapshot: Snapshot, expectedEtag?: string) {
    this.activeWrites++;
    this.maximumWrites = Math.max(this.maximumWrites, this.activeWrites);
    this.writeSummaryCounts.push(this.activeSummaries());
    try {
      await delay(1);
      if (expectedEtag !== String(this.version)) throw new WriteConflict();
      this.snapshot = structuredClone(snapshot);
      this.writes.push(structuredClone(snapshot));
      this.version++;
    } finally { this.activeWrites--; }
  }
}

function harness(summaryConcurrency?: number, maxSummaries = 20, failFirst = false) {
  const state = { active: 0, maximum: 0, attempts: 0, fetches: 0 };
  const store = new MemoryStore(() => state.active);
  const options: CollectOptions = {
    store, sources: [source], now: () => new Date('2026-10-07T19:00:00Z'),
    summaryConcurrency, maxSummaries,
    fetchDocument: async url => { state.fetches++; return { url, body, contentType: 'application/json' }; },
    summarize: async () => {
      const attempt = ++state.attempts;
      state.active++;
      state.maximum = Math.max(state.maximum, state.active);
      try {
        await delay(5);
        if (failFirst && attempt === 1) throw new Error('Model request failed');
        return explanation;
      } finally { state.active--; }
    },
  };
  return { state, store, options };
}

describe('summary concurrency', () => {
  it.each([
    { configured: undefined, expected: 3 },
    { configured: 1, expected: 1 },
    { configured: 6, expected: 6 },
  ])('uses $expected in-flight summaries when configured as $configured and keeps writes serial', async ({ configured, expected }) => {
    const h = harness(configured);
    const run = await collectOnce(h.options);
    expect(h.state.maximum).toBe(expected);
    expect(h.state.attempts).toBe(13);
    expect(h.store.snapshot.entries).toHaveLength(13);
    expect(h.store.snapshot.entries.every(entry => entry.explanationStatus === 'ready')).toBe(true);
    expect(h.store.writeSummaryCounts.every(active => active === 0)).toBe(true);
    expect(h.store.maximumWrites).toBe(1);
    expect(run).toMatchObject({ status: 'success', summarizedEntries: 13 });
    if (configured === 6) {
      expect(h.store.writes.map(snapshot => snapshot.entries.length)).toEqual([6, 12, 13]);
      expect(h.store.writes.slice(0, -1).every(snapshot => !snapshot.runs.some(item => item.id === run.id))).toBe(true);
    }
  });

  it.each([false, true])('never starts more than maxSummaries=2 at concurrency 6, including a failed attempt: %s', async failFirst => {
    const h = harness(6, 2, failFirst);
    const run = await collectOnce(h.options);
    expect(h.state.maximum).toBe(2);
    expect(h.state.attempts).toBe(2);
    expect(run).toMatchObject({ status: 'partial', summarizedEntries: failFirst ? 1 : 2 });
    expect(h.store.snapshot.entries).toHaveLength(13);
    expect(h.store.snapshot.entries.filter(entry => entry.explanationStatus === 'ready')).toHaveLength(failFirst ? 1 : 2);
    expect(h.store.snapshot.entries.filter(entry => entry.explanationStatus === 'pending')).toHaveLength(failFirst ? 12 : 11);
  });

  it.each([0, 7, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, '3'])('rejects invalid concurrency %s before any collection I/O', async value => {
    const h = harness(value as unknown as number);
    await expect(collectOnce(h.options)).rejects.toThrow('summaryConcurrency');
    expect(h.store.reads).toBe(0);
    expect(h.state.fetches).toBe(0);
    expect(h.state.attempts).toBe(0);
  });
});

async function runCli(concurrency?: string) {
  const h = harness();
  const argv = process.argv;
  const exitCode = process.exitCode;
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(message => { logs.push(String(message)); });
  const error = vi.spyOn(console, 'error').mockImplementation(message => { errors.push(String(message)); });
  vi.resetModules();
  vi.doMock('../src/collector/engine.js', () => ({
    collectOnce: (options: CollectOptions) => collectOnce({ ...options, sources: [source], now: h.options.now }),
  }));
  vi.doMock('../src/collector/explanation.js', () => ({
    BedrockExplainer: class {
      modelId = 'test-model';
      async explain(...args: Parameters<CollectOptions['summarize']>) { return h.options.summarize(...args); }
    },
    EDITORIAL_VERSION: 'test-editorial',
  }));
  vi.doMock('../src/collector/full-changes.js', () => ({
    BedrockChangeExplainer: class {
      constructor(readonly modelId: string) {}
      async explain(candidate: Candidate) {
        const items = extractChangeItems(candidate).map(item => ({ id: item.id, text: '작업 실행 수의 설정을 추가했습니다.' }));
        return { status: 'ready', sourceHash: fullChangesSourceHash(candidate), model: this.modelId,
          formatVersion: FULL_CHANGES_VERSION, updatedAt: h.options.now!().toISOString(), sourceCount: items.length, items };
      }
    },
  }));
  vi.doMock('../src/collector/official-fetch.js', () => ({ fetchOfficial: h.options.fetchDocument }));
  vi.doMock('../src/collector/store.js', () => ({ configuredStore: () => h.store }));
  try {
    process.argv = [process.execPath, 'src/collector/run.ts', ...(concurrency === undefined ? [] : ['--concurrency', concurrency])];
    process.exitCode = undefined;
    await import('../src/collector/run.js');
    return { ...h, logs: logs.map(line => JSON.parse(line)), errors: errors.map(line => JSON.parse(line)), exitCode: process.exitCode };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    log.mockRestore();
    error.mockRestore();
    vi.doUnmock('../src/collector/engine.js');
    vi.doUnmock('../src/collector/explanation.js');
    vi.doUnmock('../src/collector/full-changes.js');
    vi.doUnmock('../src/collector/official-fetch.js');
    vi.doUnmock('../src/collector/store.js');
    vi.resetModules();
  }
}

describe('collector CLI concurrency', () => {
  it.each([{ argument: undefined, expected: 3 }, { argument: '1', expected: 1 }, { argument: '6', expected: 6 }])(
    'runs the real collector at concurrency $expected for CLI value $argument',
    async ({ argument, expected }) => {
      const result = await runCli(argument);
      expect(result.exitCode).toBeUndefined();
      expect(result.errors).toEqual([]);
      expect(result.state.maximum).toBe(expected);
      expect(result.store.snapshot.entries).toHaveLength(13);
      expect(result.logs.find(item => item.event === 'collection_started')).toMatchObject({ summaryConcurrency: expected });
    },
  );

  it.each(['0', '7', '1.5', 'NaN'])('rejects CLI concurrency %s before I/O', async argument => {
    const result = await runCli(argument);
    expect(result.exitCode).toBe(1);
    expect(result.state.fetches).toBe(0);
    expect(result.state.attempts).toBe(0);
    expect(result.errors).toEqual([expect.objectContaining({ event: 'collection_failed', error: expect.stringContaining('--concurrency') })]);
    expect(result.errors[0].error).toContain('1~6');
  });
});
