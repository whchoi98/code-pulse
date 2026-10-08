import { describe, expect, it, vi } from 'vitest';
import { collectOnce as collect, type CollectOptions } from '../src/collector/engine.js';
import { emptySnapshot, type SnapshotStore, WriteConflict } from '../src/collector/store.js';
import { SOURCES } from '../src/collector/sources.js';
import type { Candidate } from '../src/collector/sources.js';
import type { Explanation, Snapshot } from '../src/shared/types.js';
import { extractChangeItems } from '../src/collector/change-items.js';
import { FULL_CHANGES_VERSION, fullChangesSourceHash } from '../src/collector/full-changes.js';

// These fixtures represent responses served at the requested URL. Transport
// redirects and pagination have their own source-reader tests.
const collectOnce = (options: CollectOptions) => collect({
  ...options,
  fetchDocument: async url => ({ ...await options.fetchDocument(url), url }),
});

class MemoryStore implements SnapshotStore {
  snapshot: Snapshot = emptySnapshot();
  version = 0;
  writes: Snapshot[] = [];
  beforeNextWrite?: () => void;
  async read() { return { snapshot: structuredClone(this.snapshot), etag: String(this.version) }; }
  async write(snapshot: Snapshot, expectedEtag?: string) {
    const beforeWrite = this.beforeNextWrite;
    this.beforeNextWrite = undefined;
    beforeWrite?.();
    if (expectedEtag !== String(this.version)) throw new WriteConflict();
    this.snapshot = structuredClone(snapshot);
    this.writes.push(structuredClone(snapshot));
    this.version++;
  }
}
const source = SOURCES[0];
const now = () => new Date('2026-10-07T19:00:00Z');
const explanation: Explanation = {
  title: '하위 에이전트의 작업 강도를 지정합니다',
  summary: 'Agent 도구에 effort 매개변수가 추가됐습니다.',
  whyItMatters: '작업에 맞춰 하위 에이전트의 추론 강도를 지정할 수 있습니다.',
  actionItems: ['하위 에이전트를 사용할 때 필요한 작업 강도를 지정해 보세요.'],
  highlights: [{ title: '작업 강도 설정', detail: 'Agent 도구에서 effort를 받습니다.', evidence: 'Added an effort parameter to the Agent tool.' }],
  audience: ['Claude Code 사용자'], category: 'feature', impact: 'medium',
};
const release = (body = 'Added an effort parameter to the Agent tool.', date = '2026-10-06T18:00:00Z') => JSON.stringify([
  { tag_name: 'v2.1.292', name: 'v2.1.292', prerelease: false, draft: false, published_at: date, html_url: `${source.url}/tag/v2.1.292`, body },
]);
const document = (body: string) => ({ body, url: source.fetchUrl, contentType: 'application/json' });
const nextDay = () => new Date('2026-10-08T19:00:00Z');
const codexRelease = (
  version = '0.161.0', body = 'Codex CLI adds workspace controls.', publishedAt = '2026-10-07T15:58:45Z',
) => ({
  tag_name: `rust-v${version}`, name: version, prerelease: false, draft: false,
  published_at: publishedAt, html_url: `https://github.com/openai/codex/releases/tag/rust-v${version}`, body,
});
const codexFeed = (anchor = 'github-release-1', body = 'Codex CLI adds workspace controls.') =>
  `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Codex CLI Release: 0.161.0</title><link>https://developers.openai.com/codex/changelog/#${anchor}</link><pubDate>Wed, 07 Oct 2026 00:00:00 GMT</pubDate><content:encoded>${body}</content:encoded></item></channel></rss>`;

describe('daily collection', () => {
  it('preserves first discovery and does not summarize or publish the same release twice', async () => {
    const store = new MemoryStore();
    let summaries = 0;
    const options = { store, sources: [source], now, fetchDocument: async () => document(release()), summarize: async () => { summaries++; return explanation; } };
    const first = await collectOnce(options);
    expect(first).toMatchObject({ status: 'success', newEntries: 1, summarizedEntries: 1 });
    const firstSeen = store.snapshot.entries[0].firstSeenAt;
    const second = await collectOnce({ ...options, now: () => new Date('2026-10-08T00:00:00Z') });
    expect(second).toMatchObject({ status: 'success', newEntries: 0, updatedEntries: 0, summarizedEntries: 0 });
    expect(store.snapshot.entries).toHaveLength(1);
    expect(store.snapshot.entries[0].firstSeenAt).toBe(firstSeen);
    expect(summaries).toBe(1);
  });

  it('replaces a changed explanation while preserving the original publication date', async () => {
    const store = new MemoryStore();
    const options = { store, sources: [source], now, fetchDocument: async () => document(release()), summarize: async () => explanation };
    await collectOnce(options);
    const updated = await collectOnce({ ...options, fetchDocument: async () => document(release('Added an effort parameter to the Agent tool. Fixed permission checks.')) });
    expect(updated.updatedEntries).toBe(1);
    expect(store.snapshot.entries).toHaveLength(1);
    expect(store.snapshot.entries[0].publishedDate).toBe('2026-10-06');
    expect(store.snapshot.entries[0].originalText).toContain('Fixed permission checks.');
  });

  it('retains existing entries when one source fails and continues collecting the others', async () => {
    const store = new MemoryStore();
    const options = { store, sources: [source], now, fetchDocument: async () => document(release()), summarize: async () => explanation };
    await collectOnce(options);
    const run = await collectOnce({
      ...options, sources: [source, SOURCES[3]],
      fetchDocument: async url => {
        if (url === SOURCES[3].fetchUrl) throw new Error('HTTP 503');
        return document(release());
      },
    });
    expect(run.status).toBe('partial');
    expect(store.snapshot.entries).toHaveLength(1);
    expect(store.snapshot.sources.find(s => s.id === 'kiro-changelog')?.state).toBe('error');
    expect(store.snapshot.sources.find(s => s.id === source.id)?.state).toBe('ok');
  });

  it('records total source failure without presenting it as a successful empty day', async () => {
    const store = new MemoryStore();
    const run = await collectOnce({ store, sources: [source], now, fetchDocument: async () => { throw new Error('HTTP 503'); }, summarize: async () => explanation });
    expect(run.status).toBe('failed');
    expect(store.snapshot.sources[0]).toMatchObject({ state: 'error', entryCount: 0 });
    expect(store.snapshot.runs).toHaveLength(1);
  });

  it('keeps untranslated source material and retries the explanation on the next run', async () => {
    const store = new MemoryStore();
    const options = { store, sources: [source], now, fetchDocument: async () => document(release()) };
    await collectOnce({ ...options, summarize: async () => { throw new Error('model unavailable'); } });
    expect(store.snapshot.entries[0]).toMatchObject({ explanationStatus: 'pending', originalText: 'Added an effort parameter to the Agent tool.' });
    expect(store.snapshot.entries[0].explanation).toBeUndefined();
    const retry = await collectOnce({ ...options, summarize: async () => explanation });
    expect(retry.summarizedEntries).toBe(1);
    expect(store.snapshot.entries[0].explanation?.title).toBe(explanation.title);
  });

  it('does not publish a future release or invent today as the release date', async () => {
    const store = new MemoryStore();
    await collectOnce({ store, sources: [source], now, fetchDocument: async () => document(release(undefined, '2026-10-08T18:00:00Z')), summarize: async () => explanation });
    expect(store.snapshot.entries).toHaveLength(0);
  });
  it('merges the same Codex release found in GitHub and the product changelog while keeping both links', async () => {
    const store = new MemoryStore();
    const github = JSON.stringify([{ tag_name: 'rust-v0.161.0', name: '0.161.0', prerelease: false, draft: false, published_at: '2026-10-07T15:58:45Z', html_url: 'https://github.com/openai/codex/releases/tag/rust-v0.161.0', body: 'Codex CLI adds workspace controls.' }]);
    const rss = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Codex CLI Release: 0.161.0</title><link>https://developers.openai.com/codex/changelog/#github-release-1</link><pubDate>Wed, 07 Oct 2026 00:00:00 GMT</pubDate><content:encoded>Codex CLI adds workspace controls.</content:encoded></item></channel></rss>`;
    const run = await collectOnce({
      store, sources: [SOURCES[1], SOURCES[2]], now, summarize: async () => explanation,
      fetchDocument: async url => document(url.includes('api.github.com') ? github : rss),
    });
    expect(run.newEntries).toBe(1);
    expect(store.snapshot.entries).toHaveLength(1);
    expect(store.snapshot.entries[0].references.map(reference => reference.url)).toEqual([
      'https://github.com/openai/codex/releases/tag/rust-v0.161.0',
      'https://developers.openai.com/codex/changelog/#github-release-1',
    ]);
    expect(store.snapshot.entries[0].publishedAt).toBe('2026-10-07T15:58:45.000Z');
  });
  it('migrates a previously imported RSS release to its canonical ID without generating a duplicate explanation', async () => {
    const store = new MemoryStore();
    const rss = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Codex CLI Release: 0.159.1</title><link>https://developers.openai.com/codex/changelog/#github-release-159</link><pubDate>Tue, 29 Sep 2026 00:00:00 GMT</pubDate><content:encoded>Codex CLI adds workspace controls.</content:encoded></item></channel></rss>`;
    const options = { store, sources: [SOURCES[2]], now, fetchDocument: async () => document(rss), summarize: async () => explanation };
    await collectOnce(options);
    store.snapshot.entries[0] = { ...store.snapshot.entries[0], id: 'codex-legacy-url-id', version: undefined };
    const run = await collectOnce({ ...options, summarize: async () => { throw new Error('must reuse unchanged explanation'); } });
    expect(run.newEntries).toBe(0);
    expect(run.summarizedEntries).toBe(0);
    expect(store.snapshot.entries).toHaveLength(1);
    expect(store.snapshot.entries[0].id).not.toBe('codex-legacy-url-id');
    expect(store.snapshot.entries[0].explanationStatus).toBe('ready');
  });

  it.each(['unavailable', 'off the first page'] as const)(
    'retains a stored canonical release when GitHub is %s and RSS still includes it',
    async githubState => {
      const store = new MemoryStore();
      await collectOnce({
        store, sources: [SOURCES[1], SOURCES[2]], now,
        modelId: 'original-model', editorialVersion: 'human-ton-1', summarize: async () => explanation,
        fetchDocument: async url => document(url === SOURCES[1].fetchUrl
          ? JSON.stringify([codexRelease()]) : codexFeed()),
      });
      const original = structuredClone(store.snapshot.entries[0]);
      const run = await collectOnce({
        store, sources: [SOURCES[1], SOURCES[2]], now: nextDay,
        fetchDocument: async url => {
          if (url !== SOURCES[1].fetchUrl) return document(codexFeed('updated-feed-link', 'Codex CLI RSS has a shorter description.'));
          if (githubState === 'unavailable') throw new Error('HTTP 503');
          return document(JSON.stringify([codexRelease('0.162.0', 'Codex CLI adds another feature.', '2026-10-08T10:00:00Z')]));
        },
        summarize: async candidate => {
          if (candidate.version === '0.161.0') throw new Error('The unchanged canonical release must not be summarized again.');
          return explanation;
        },
      });

      expect(run.updatedEntries).toBe(0);
      expect(run.summarizedEntries).toBe(githubState === 'unavailable' ? 0 : 1);
      expect(store.snapshot.entries.find(entry => entry.version === '0.161.0')).toEqual({
        ...original,
        references: [
          ...original.references,
          { title: 'Codex 공식 변경 기록', kind: 'changelog', url: 'https://developers.openai.com/codex/changelog/#updated-feed-link' },
        ],
      });
      expect(store.snapshot.sources.find(item => item.id === 'codex-changelog')?.lastSuccessAt).toBe('2026-10-08T19:00:00.000Z');
    },
  );

  it('accepts a genuine primary-source update without losing previously collected RSS references', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [SOURCES[1], SOURCES[2]], now, summarize: async () => explanation,
      fetchDocument: async url => document(url === SOURCES[1].fetchUrl ? JSON.stringify([codexRelease()]) : codexFeed()),
    });
    const original = structuredClone(store.snapshot.entries[0]);
    const revised = { ...explanation, title: '공식 릴리스의 수정된 내용을 설명합니다' };
    const run = await collectOnce({
      store, sources: [SOURCES[1]], now: nextDay, summarize: async () => revised,
      fetchDocument: async () => document(JSON.stringify([codexRelease('0.161.0', 'Codex CLI adds workspace controls. Fixed permissions.')])),
    });

    expect(run).toMatchObject({ status: 'success', updatedEntries: 1, summarizedEntries: 1 });
    expect(store.snapshot.entries[0]).toMatchObject({
      sourceId: 'codex-releases', originalText: 'Codex CLI adds workspace controls. Fixed permissions.',
      publishedAt: '2026-10-07T15:58:45.000Z', datePrecision: 'timestamp',
      firstSeenAt: original.firstSeenAt, checkedAt: '2026-10-08T19:00:00.000Z',
      references: original.references, explanation: revised, explanationStatus: 'ready',
    });
    expect(store.snapshot.entries[0].contentHash).not.toBe(original.contentHash);
  });

  it('promotes an RSS-only release to GitHub while retaining the RSS reference and first discovery', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [SOURCES[2]], now, summarize: async () => explanation,
      fetchDocument: async () => document(codexFeed()),
    });
    const firstSeenAt = store.snapshot.entries[0].firstSeenAt;
    const run = await collectOnce({
      store, sources: [SOURCES[1]], now: nextDay, summarize: async () => explanation,
      fetchDocument: async () => document(JSON.stringify([codexRelease()])),
    });

    expect(run).toMatchObject({ newEntries: 0, updatedEntries: 1, summarizedEntries: 1 });
    expect(store.snapshot.entries).toHaveLength(1);
    expect(store.snapshot.entries[0]).toMatchObject({
      sourceId: 'codex-releases', firstSeenAt, publishedAt: '2026-10-07T15:58:45.000Z',
      checkedAt: '2026-10-08T19:00:00.000Z', explanationStatus: 'ready',
    });
    expect(store.snapshot.entries[0].references.map(reference => reference.url)).toEqual([
      'https://github.com/openai/codex/releases/tag/rust-v0.161.0',
      'https://developers.openai.com/codex/changelog/#github-release-1',
    ]);
  });

  it('retries a stored pending release that has fallen off the current feed using its verified source', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [SOURCES[1]], now, maxSummaries: 0, summarize: async () => explanation,
      fetchDocument: async () => document(JSON.stringify([codexRelease()])),
    });
    const original = structuredClone(store.snapshot.entries[0]);
    const summarized: Candidate[] = [];
    const run = await collectOnce({
      store, sources: [SOURCES[1]], now: nextDay, modelId: 'retry-model',
      fetchDocument: async () => document(JSON.stringify([codexRelease('0.162.0', 'Codex CLI adds another feature.', '2026-10-08T10:00:00Z')])),
      summarize: async candidate => { summarized.push(candidate); return explanation; },
    });

    expect(run).toMatchObject({ status: 'success', newEntries: 1, updatedEntries: 0, summarizedEntries: 2 });
    expect(summarized.find(candidate => candidate.version === '0.161.0')).toMatchObject({
      sourceId: 'codex-releases', sourceUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.161.0',
      originalTitle: '0.161.0', originalText: 'Codex CLI adds workspace controls.',
      publishedAt: '2026-10-07T15:58:45.000Z',
    });
    expect(store.snapshot.entries.find(entry => entry.id === original.id)).toMatchObject({
      ...original, explanationStatus: 'ready', explanation, explanationModel: 'retry-model',
      explanationEditedAt: '2026-10-08T19:00:00.000Z',
    });
  });

  it('retries stored pending material outside the discovery lookback without advancing its source check', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [source], now, fetchDocument: async () => document(release()),
      summarize: async () => explanation,
    };
    await collectOnce({ ...options, maxSummaries: 0 });
    const original = structuredClone(store.snapshot.entries[0]);
    const run = await collectOnce({ ...options, now: nextDay, lookbackDays: 1 });

    expect(run).toMatchObject({ status: 'success', newEntries: 0, updatedEntries: 0, summarizedEntries: 1 });
    expect(store.snapshot.entries[0]).toMatchObject({ ...original, explanationStatus: 'ready', explanation });
    expect(store.snapshot.sources[0]).toMatchObject({ state: 'ok', entryCount: 0, lastSuccessAt: '2026-10-08T19:00:00.000Z' });
  });

  it('retries stored pending material during a source outage without reporting a new source verification', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [source], now, maxSummaries: 0,
      fetchDocument: async () => document(release()), summarize: async () => explanation,
    });
    const original = structuredClone(store.snapshot.entries[0]);
    const run = await collectOnce({
      store, sources: [source], now: nextDay,
      fetchDocument: async () => { throw new Error('HTTP 503'); }, summarize: async () => explanation,
    });

    expect(run).toMatchObject({ status: 'failed', summarizedEntries: 1, failedSources: [source.id] });
    expect(store.snapshot.entries[0]).toMatchObject({ ...original, explanationStatus: 'ready', explanation });
    expect(store.snapshot.sources[0]).toMatchObject({ state: 'error', lastSuccessAt: '2026-10-07T19:00:00.000Z' });
  });

  it.each([0, 1])('reports partial when the summary budget of %i leaves stored pending entries', async maxSummaries => {
    const store = new MemoryStore();
    const options = {
      store, sources: [SOURCES[1]], now, summarize: async () => explanation,
      fetchDocument: async () => document(JSON.stringify([codexRelease(), codexRelease('0.160.0')])),
    };
    await collectOnce({ ...options, maxSummaries: 0 });
    const run = await collectOnce({ ...options, now: nextDay, lookbackDays: 0, maxSummaries });

    expect(run).toMatchObject({ status: 'partial', newEntries: 0, updatedEntries: 0, summarizedEntries: maxSummaries });
    expect(store.snapshot.entries.filter(entry => entry.explanationStatus === 'pending')).toHaveLength(2 - maxSummaries);
    expect(store.snapshot.runs.find(item => item.id === run.id)?.status).toBe('partial');
    expect(store.snapshot.entries.every(entry => entry.checkedAt === '2026-10-07T19:00:00.000Z')).toBe(true);
  });

  it('reports partial when the wall-clock budget expires with persisted retries still pending', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [SOURCES[1]], now,
      fetchDocument: async () => document(JSON.stringify([codexRelease(), codexRelease('0.160.0')])),
      summarize: async () => explanation,
    };
    await collectOnce({ ...options, maxSummaries: 0 });
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const run = await collectOnce({
        ...options, now: nextDay, lookbackDays: 0,
        summarize: async () => { wallClock.mockReturnValue(14 * 60_000); return explanation; },
      });
      expect(run).toMatchObject({ status: 'partial', summarizedEntries: 1 });
      expect(store.snapshot.entries.filter(entry => entry.explanationStatus === 'pending')).toHaveLength(1);
      expect(store.snapshot.runs.find(item => item.id === run.id)?.status).toBe('partial');
    } finally {
      wallClock.mockRestore();
    }
  });

  it.each(['final commit', 'checkpoint'] as const)(
    'preserves a newer explanation and its metadata after an ETag conflict at the %s',
    async boundary => {
      const store = new MemoryStore();
      const versions = boundary === 'checkpoint'
        ? ['0.161.0', '0.160.0', '0.159.0', '0.158.0', '0.157.0', '0.156.0'] : ['0.161.0'];
      const options = {
        store, sources: [SOURCES[1]], now, modelId: 'original-model', editorialVersion: 'human-ton-1',
        summarize: async () => explanation,
        fetchDocument: async () => document(JSON.stringify(versions.map(version => codexRelease(version)))),
      };
      await collectOnce(options);
      const targetVersion = boundary === 'checkpoint' ? '0.160.0' : '0.161.0';
      const polished = { ...explanation, title: '동시에 저장한 최신 윤문을 유지합니다' };
      store.writes = [];
      store.beforeNextWrite = () => {
        const entry = store.snapshot.entries.find(item => item.version === targetVersion)!;
        Object.assign(entry, {
          explanation: polished, explanationModel: 'polish-model', editorialVersion: 'human-ton-2',
          explanationEditedAt: '2026-10-08T19:01:00.000Z',
        });
        store.version++;
      };
      const run = await collectOnce({
        ...options, now: nextDay,
        fetchDocument: async () => document(JSON.stringify(versions.map((version, index) => codexRelease(
          version, boundary === 'checkpoint' && index === 0 ? 'Codex CLI fixes another issue.' : undefined,
        )))),
      });

      expect(run.status).toBe('success');
      expect(store.writes).toHaveLength(boundary === 'checkpoint' ? 2 : 1);
      for (const snapshot of store.writes) {
        expect(snapshot.entries.find(entry => entry.version === targetVersion)).toMatchObject({
          explanation: polished, explanationStatus: 'ready', explanationModel: 'polish-model',
          editorialVersion: 'human-ton-2', explanationEditedAt: '2026-10-08T19:01:00.000Z',
          checkedAt: '2026-10-08T19:00:00.000Z',
        });
      }
      if (boundary === 'checkpoint') expect(store.writes[0].runs.some(item => item.id === run.id)).toBe(false);
      expect(store.snapshot.runs.some(item => item.id === run.id)).toBe(true);
    },
  );

  it('merges a newly completed explanation with a later observation of the same source content', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [source], now, maxSummaries: 0,
      fetchDocument: async () => document(release()), summarize: async () => explanation,
    });
    store.beforeNextWrite = () => {
      store.snapshot.entries[0].checkedAt = '2026-10-08T19:01:00.000Z';
      store.version++;
    };
    let time = nextDay();
    const run = await collectOnce({
      store, sources: [source], now: () => time, lookbackDays: 0,
      fetchDocument: async () => document(release()),
      summarize: async () => { time = new Date('2026-10-08T19:02:00Z'); return explanation; },
    });

    expect(run).toMatchObject({ status: 'success', summarizedEntries: 1 });
    expect(store.snapshot.entries[0]).toMatchObject({
      checkedAt: '2026-10-08T19:01:00.000Z', explanation, explanationStatus: 'ready',
      explanationEditedAt: '2026-10-08T19:02:00.000Z',
    });
  });

  it('invalidates an old explanation after a source change even if a concurrent editor saved it later', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [source], now, modelId: 'old-model', editorialVersion: 'human-ton-1',
      fetchDocument: async () => document(release()), summarize: async () => explanation,
    };
    await collectOnce(options);
    store.beforeNextWrite = () => {
      Object.assign(store.snapshot.entries[0], {
        explanation: { ...explanation, title: '이전 원문에 대한 최신 윤문입니다' },
        editorialVersion: 'human-ton-2', explanationEditedAt: '2026-10-08T19:01:00.000Z',
      });
      store.version++;
    };
    const run = await collectOnce({
      ...options, now: nextDay, maxSummaries: 0,
      fetchDocument: async () => document(release('Added an effort parameter to the Agent tool. Fixed permission checks.')),
    });

    expect(run).toMatchObject({ status: 'partial', updatedEntries: 1, summarizedEntries: 0 });
    expect(store.snapshot.entries[0]).toMatchObject({
      originalText: 'Added an effort parameter to the Agent tool. Fixed permission checks.',
      explanationStatus: 'pending', checkedAt: '2026-10-08T19:00:00.000Z',
    });
    expect(store.snapshot.entries[0].explanation).toBeUndefined();
    expect(store.snapshot.entries[0].explanationModel).toBeUndefined();
    expect(store.snapshot.entries[0].editorialVersion).toBeUndefined();
    expect(store.snapshot.entries[0].explanationEditedAt).toBeUndefined();
  });

  it('reports partial if an ETag retry reloads another persisted pending entry', async () => {
    const store = new MemoryStore();
    const concurrent = new MemoryStore();
    const options = {
      sources: [SOURCES[1]], now, summarize: async () => explanation,
      fetchDocument: async () => document(JSON.stringify([codexRelease()])),
    };
    await collectOnce({ ...options, store });
    await collectOnce({
      ...options, store: concurrent, maxSummaries: 0,
      fetchDocument: async () => document(JSON.stringify([codexRelease('0.160.0')])),
    });
    store.beforeNextWrite = () => {
      store.snapshot.entries.push(structuredClone(concurrent.snapshot.entries[0]));
      store.version++;
    };
    const run = await collectOnce({ ...options, store, now: nextDay });

    expect(run).toMatchObject({ status: 'partial', summarizedEntries: 0 });
    expect(store.snapshot.entries.filter(entry => entry.explanationStatus === 'pending')).toHaveLength(1);
    expect(store.snapshot.runs.find(item => item.id === run.id)?.status).toBe('partial');
  });
});

describe('opt-in explanation model refresh', () => {
  const refreshed: Explanation = { ...explanation, title: '새 모델로 작업 강도 설정을 설명합니다' };

  it.each(['current feed', 'not in feed', 'outside lookback', 'legacy model'] as const)(
    'refreshes a ready explanation from the verified source: %s',
    async discovery => {
      const store = new MemoryStore();
      const options = {
        store, sources: [SOURCES[1]], now, modelId: discovery === 'legacy model' ? undefined : 'old-model',
        editorialVersion: 'old-editorial', summarize: async () => explanation,
        fetchDocument: async () => document(JSON.stringify([codexRelease()])),
      };
      await collectOnce(options);
      const original = structuredClone(store.snapshot.entries[0]);
      let visibleDuringRefresh: Snapshot | undefined;
      let refreshedSource: Candidate | undefined;
      const run = await collectOnce({
        ...options, now: nextDay, refreshModel: true, modelId: 'target-model', editorialVersion: 'target-editorial',
        lookbackDays: discovery === 'outside lookback' ? 0 : 45,
        fetchDocument: async () => document(JSON.stringify([
          discovery === 'not in feed'
            ? codexRelease('0.162.0', 'Codex CLI adds another feature.', '2026-10-08T10:00:00Z') : codexRelease(),
        ])),
        summarize: async candidate => {
          if (candidate.version === '0.161.0') {
            visibleDuringRefresh = structuredClone(store.snapshot);
            refreshedSource = candidate;
          }
          return refreshed;
        },
      });

      expect(run).toMatchObject({
        status: 'success', newEntries: discovery === 'not in feed' ? 1 : 0,
        updatedEntries: 0, summarizedEntries: discovery === 'not in feed' ? 2 : 1,
      });
      expect(visibleDuringRefresh?.entries.find(entry => entry.id === original.id)).toEqual(original);
      expect(refreshedSource).toMatchObject({
        sourceId: 'codex-releases', sourceUrl: original.sourceUrl,
        originalText: original.originalText, publishedAt: original.publishedAt,
      });
      expect(store.snapshot.entries.find(entry => entry.id === original.id)).toEqual({
        ...original,
        checkedAt: discovery === 'current feed' || discovery === 'legacy model' ? '2026-10-08T19:00:00.000Z' : original.checkedAt,
        explanation: refreshed, explanationModel: 'target-model', editorialVersion: 'target-editorial',
        explanationEditedAt: '2026-10-08T19:00:00.000Z',
      });
    },
  );

  it('keeps existing ready explanations on their model unless refresh is explicitly enabled', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [source], now, modelId: 'old-model',
      fetchDocument: async () => document(release()), summarize: async () => explanation,
    };
    await collectOnce(options);
    const run = await collectOnce({ ...options, now: nextDay, modelId: 'target-model', summarize: async () => refreshed });

    expect(run).toMatchObject({ status: 'success', summarizedEntries: 0 });
    expect(store.snapshot.entries[0]).toMatchObject({ explanation, explanationModel: 'old-model', explanationStatus: 'ready' });
  });

  it('does not regenerate an unchanged explanation already on the requested model', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [source], now, modelId: 'target-model',
      fetchDocument: async () => document(release()), summarize: async () => explanation,
    };
    await collectOnce(options);
    const run = await collectOnce({ ...options, now: nextDay, refreshModel: true, summarize: async () => refreshed });

    expect(run).toMatchObject({ status: 'success', summarizedEntries: 0 });
    expect(store.snapshot.entries[0]).toMatchObject({
      explanation, explanationModel: 'target-model', explanationEditedAt: '2026-10-07T19:00:00.000Z',
    });
  });

  it('keeps the ready explanation and its metadata when refresh generation fails', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [source], now, modelId: 'old-model', editorialVersion: 'old-editorial',
      fetchDocument: async () => document(release()), summarize: async () => explanation,
    };
    await collectOnce(options);
    const original = structuredClone(store.snapshot.entries[0]);
    const warnings: string[] = [];
    const run = await collectOnce({
      ...options, now: nextDay, lookbackDays: 0, refreshModel: true, modelId: 'target-model', editorialVersion: 'target-editorial',
      summarize: async () => { throw new Error('replacement model unavailable'); },
      onWarning: warning => warnings.push(warning.message),
    });

    expect(run).toMatchObject({ status: 'partial', newEntries: 0, updatedEntries: 0, summarizedEntries: 0 });
    expect(store.snapshot.entries[0]).toEqual(original);
    expect(store.snapshot.runs.find(item => item.id === run.id)?.status).toBe('partial');
    expect(warnings).toEqual(['replacement model unavailable']);
  });

  it.each([0, 1])('keeps ready posts visible and resumes remaining refreshes after a budget of %i', async maxSummaries => {
    const store = new MemoryStore();
    const options = {
      store, sources: [SOURCES[1]], now, modelId: 'old-model',
      fetchDocument: async () => document(JSON.stringify([codexRelease(), codexRelease('0.160.0')])),
      summarize: async () => explanation,
    };
    await collectOnce(options);
    const refreshOptions = {
      ...options, now: nextDay, lookbackDays: 0, refreshModel: true, modelId: 'target-model',
      summarize: async () => refreshed,
    };
    const run = await collectOnce({ ...refreshOptions, maxSummaries });

    expect(run).toMatchObject({ status: 'partial', newEntries: 0, updatedEntries: 0, summarizedEntries: maxSummaries });
    expect(store.snapshot.entries.every(entry => entry.explanationStatus === 'ready')).toBe(true);
    expect(store.snapshot.entries.filter(entry => entry.explanationModel === 'old-model')).toHaveLength(2 - maxSummaries);
    expect(store.snapshot.entries.every(entry => entry.checkedAt === '2026-10-07T19:00:00.000Z')).toBe(true);
    expect(store.snapshot.runs.find(item => item.id === run.id)?.status).toBe('partial');

    const retry = await collectOnce({ ...refreshOptions, maxSummaries: 80 });
    expect(retry).toMatchObject({ status: 'success', summarizedEntries: 2 - maxSummaries });
    expect(store.snapshot.entries.every(entry => entry.explanationModel === 'target-model')).toBe(true);
  });

  it('reports incomplete model refreshes when the time budget expires while all posts remain ready', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [SOURCES[1]], now, modelId: 'old-model',
      fetchDocument: async () => document(JSON.stringify([codexRelease(), codexRelease('0.160.0')])),
      summarize: async () => explanation,
    };
    await collectOnce(options);
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const run = await collectOnce({
        ...options, now: nextDay, lookbackDays: 0, refreshModel: true, modelId: 'target-model',
        summarize: async () => { wallClock.mockReturnValue(14 * 60_000); return refreshed; },
      });

      expect(run).toMatchObject({ status: 'partial', summarizedEntries: 1 });
      expect(store.snapshot.entries.every(entry => entry.explanationStatus === 'ready')).toBe(true);
      expect(store.snapshot.entries.filter(entry => entry.explanationModel === 'old-model')).toHaveLength(1);
      expect(store.snapshot.runs.find(item => item.id === run.id)?.status).toBe('partial');
    } finally {
      wallClock.mockRestore();
    }
  });

  it('refreshes from the stored GitHub source when only the secondary RSS release is observed', async () => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [SOURCES[1], SOURCES[2]], now, modelId: 'old-model', summarize: async () => explanation,
      fetchDocument: async url => document(url === SOURCES[1].fetchUrl ? JSON.stringify([codexRelease()]) : codexFeed()),
    });
    const original = structuredClone(store.snapshot.entries[0]);
    let refreshedSource: Candidate | undefined;
    const run = await collectOnce({
      store, sources: [SOURCES[2]], now: nextDay, refreshModel: true, modelId: 'target-model',
      fetchDocument: async () => document(codexFeed('github-release-1', 'Codex CLI has a shorter RSS description.')),
      summarize: async candidate => { refreshedSource = candidate; return refreshed; },
    });

    expect(run).toMatchObject({ status: 'success', updatedEntries: 0, summarizedEntries: 1 });
    expect(refreshedSource).toMatchObject({ sourceId: 'codex-releases', originalText: original.originalText });
    expect(store.snapshot.entries[0]).toEqual({
      ...original, explanation: refreshed, explanationModel: 'target-model',
      explanationEditedAt: '2026-10-08T19:00:00.000Z',
    });
  });

  it('preserves a newer editorial conflict winner and reports its requested model refresh as incomplete', async () => {
    const store = new MemoryStore();
    const options = {
      store, sources: [source], now, modelId: 'old-model', editorialVersion: 'old-editorial',
      fetchDocument: async () => document(release()), summarize: async () => explanation,
    };
    await collectOnce(options);
    const polished = { ...explanation, title: '갱신 작업보다 늦게 저장된 윤문입니다' };
    store.beforeNextWrite = () => {
      Object.assign(store.snapshot.entries[0], {
        explanation: polished, editorialVersion: 'concurrent-editorial',
        explanationEditedAt: '2026-10-08T19:01:00.000Z',
      });
      store.version++;
    };
    const run = await collectOnce({
      ...options, now: nextDay, lookbackDays: 0, refreshModel: true, modelId: 'target-model',
      editorialVersion: 'target-editorial', summarize: async () => refreshed,
    });

    expect(run).toMatchObject({ status: 'partial', summarizedEntries: 1 });
    expect(store.snapshot.entries[0]).toMatchObject({
      explanation: polished, explanationStatus: 'ready', explanationModel: 'old-model',
      editorialVersion: 'concurrent-editorial', explanationEditedAt: '2026-10-08T19:01:00.000Z',
    });
    expect(store.snapshot.runs.find(item => item.id === run.id)?.status).toBe('partial');
  });

  it('keeps all posts ready at refresh checkpoints, including work left for the next run', async () => {
    const store = new MemoryStore();
    const versions = ['0.161.0', '0.160.0', '0.159.0', '0.158.0', '0.157.0', '0.156.0'];
    const options = {
      store, sources: [SOURCES[1]], now, modelId: 'old-model',
      fetchDocument: async () => document(JSON.stringify(versions.map(version => codexRelease(version)))),
      summarize: async () => explanation,
    };
    await collectOnce(options);
    store.writes = [];
    const run = await collectOnce({
      ...options, now: nextDay, lookbackDays: 0, refreshModel: true, modelId: 'target-model', maxSummaries: 5,
      summarize: async () => refreshed,
    });

    expect(run).toMatchObject({ status: 'partial', summarizedEntries: 5 });
    expect(store.writes).toHaveLength(2);
    for (const snapshot of store.writes) {
      expect(snapshot.entries).toHaveLength(6);
      expect(snapshot.entries.every(entry => entry.explanationStatus === 'ready')).toBe(true);
      expect(snapshot.entries.filter(entry => entry.explanationModel === 'target-model')).toHaveLength(5);
      expect(snapshot.entries.find(entry => entry.explanationModel === 'old-model')?.explanation).toEqual(explanation);
    }
    expect(store.writes[0].runs.some(item => item.id === run.id)).toBe(false);
    expect(store.snapshot.runs.find(item => item.id === run.id)?.status).toBe('partial');
  });

  it.each([false, true])('exposes the CLI model refresh as an opt-in flag: enabled=%s', async enabled => {
    const store = new MemoryStore();
    await collectOnce({
      store, sources: [source], now, modelId: 'old-model',
      fetchDocument: async () => document(release()), summarize: async () => explanation,
    });
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('../src/collector/engine.js', () => ({
      collectOnce: (options: CollectOptions) => collectOnce({ ...options, sources: [source], now: nextDay }),
    }));
    vi.doMock('../src/collector/explanation.js', () => ({
      BedrockExplainer: class {
        modelId = 'target-model';
        async explain() { return refreshed; }
      },
      EDITORIAL_VERSION: 'target-editorial',
    }));
    vi.doMock('../src/collector/full-changes.js', () => ({
      BedrockChangeExplainer: class {
        constructor(readonly modelId: string) {}
        async explain(candidate: Candidate) {
          const items = extractChangeItems(candidate).map(item => ({ id: item.id, text: '하위 에이전트의 작업 강도를 설정하도록 개선했습니다.' }));
          return { status: 'ready', sourceHash: fullChangesSourceHash(candidate), model: this.modelId,
            formatVersion: FULL_CHANGES_VERSION, updatedAt: nextDay().toISOString(), sourceCount: items.length, items };
        }
      },
    }));
    vi.doMock('../src/collector/official-fetch.js', () => ({ fetchOfficial: async () => document(release()) }));
    vi.doMock('../src/collector/store.js', () => ({ configuredStore: () => store }));
    try {
      process.argv = [process.execPath, 'src/collector/run.ts', ...(enabled ? ['--refresh-model'] : [])];
      process.exitCode = undefined;
      await import('../src/collector/run.js');

      expect(store.snapshot.entries[0]).toMatchObject({
        explanation: enabled ? refreshed : explanation,
        explanationModel: enabled ? 'target-model' : 'old-model', explanationStatus: 'ready',
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
      log.mockRestore();
      error.mockRestore();
      vi.doUnmock('../src/collector/engine.js');
      vi.doUnmock('../src/collector/explanation.js');
      vi.doUnmock('../src/collector/full-changes.js');
      vi.doUnmock('../src/collector/official-fetch.js');
      vi.doUnmock('../src/collector/store.js');
      vi.resetModules();
    }
  });
});
