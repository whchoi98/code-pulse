import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { collectOnce, mergeImportedSnapshot, type CollectOptions } from '../src/collector/engine.js';
import { extractChangeItems } from '../src/collector/change-items.js';
import { FULL_CHANGES_VERSION } from '../src/collector/full-changes.js';
import { DEFAULT_MODEL_ID } from '../src/collector/explanation.js';
import { emptySnapshot, WriteConflict, type SnapshotStore } from '../src/collector/store.js';
import { SOURCES, parseGithubReleases, parseCodexFeed, parseKiroChangelog, type Candidate } from '../src/collector/sources.js';
import { parseClaudeChangelog } from '../src/collector/claude-docs.js';
import { createServer } from '../src/server/app.js';
import type { Entry, Explanation, FullChanges, Snapshot } from '../src/shared/types.js';

const now = () => new Date('2026-10-08T06:00:00Z');
const source = SOURCES[0];
const body = Array.from({ length: 56 }, (_, index) => `- Fixed issue ${index + 1} without dropping its condition.`).join('\n');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const explanation: Explanation = {
  title: '작업 상태의 문제를 수정했습니다', summary: '여러 작업 상태를 바로잡았습니다.',
  whyItMatters: '작업을 이어서 수행할 때 상태를 확인합니다.', actionItems: ['기존 작업 상태를 확인하세요.'],
  highlights: [{ title: '작업 상태 수정', detail: '작업 상태를 올바르게 표시합니다.', evidence: 'Fixed issue 1' }],
  audience: ['도구 사용자'], category: 'fix', impact: 'medium',
};
const release = (text = body) => JSON.stringify([{ tag_name: 'v2.1.293', name: 'v2.1.293',
  prerelease: false, draft: false, published_at: '2026-10-07T18:10:20Z',
  html_url: `${source.url}/tag/v2.1.293`, body: text }]);
const candidate = (): Candidate => parseGithubReleases(release(), source)[0];
function details(value: Pick<Candidate, 'originalTitle' | 'originalText'>): FullChanges {
  const items = extractChangeItems(value).map((item, index) => ({ id: item.id, text: `변경 ${index + 1}의 조건을 유지하며 문제를 수정했습니다.` }));
  return { status: 'ready', sourceHash: hash(`${value.originalTitle}\n${value.originalText}`), model: DEFAULT_MODEL_ID,
    formatVersion: FULL_CHANGES_VERSION, updatedAt: now().toISOString(), sourceCount: items.length, items };
}
function entry(): Entry {
  const value = candidate();
  return { ...value, id: `claude-code-${hash('claude-code:cli:2.1.293').slice(0, 20)}`,
    contentHash: hash(`${value.originalTitle}\n${value.originalText}`), firstSeenAt: '2026-10-07T19:00:00Z',
    checkedAt: '2026-10-07T19:00:00Z', updatedAt: '2026-10-07T19:00:00Z', explanationStatus: 'ready',
    explanation, explanationModel: DEFAULT_MODEL_ID, fullChanges: details(value) };
}
class MemoryStore implements SnapshotStore {
  snapshot: Snapshot = emptySnapshot();
  version = 0;
  writes: Snapshot[] = [];
  async read() { return { snapshot: structuredClone(this.snapshot), etag: String(this.version) }; }
  async write(value: Snapshot, etag?: string) {
    if (etag !== String(this.version)) throw new WriteConflict();
    this.snapshot = structuredClone(value); this.writes.push(structuredClone(value)); this.version++;
  }
}
const options = (store: MemoryStore): CollectOptions => ({
  store, sources: [source], now, sinceDate: '2026-01-01', modelId: DEFAULT_MODEL_ID,
  fetchDocument: async url => ({ url, body: release(), contentType: 'application/json' }),
  summarize: async () => explanation,
});
const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(app => app.close())); });
async function server(value: Entry) {
  const store = new MemoryStore();
  store.snapshot.entries = [value];
  const app = await createServer(store, { staticDirectory: false, publicBaseUrl: 'https://pulse.example', now, cacheTtlMs: 0 });
  servers.push(app);
  return app;
}

describe('complete collection integration', () => {
  it('writes all source items and keeps the complete list on unchanged collection without new generation', async () => {
    const store = new MemoryStore();
    const expandChanges = vi.fn(async (value: Candidate) => details(value));
    const first = await collectOnce({ ...options(store), expandChanges });
    expect(first.status).toBe('success');
    expect(store.snapshot.entries[0].fullChanges?.items).toHaveLength(56);
    const original = store.snapshot.entries[0];
    await collectOnce({ ...options(store), expandChanges, now: () => new Date('2026-10-08T07:00:00Z') });
    expect(expandChanges).toHaveBeenCalledTimes(1);
    expect(store.snapshot.entries[0].fullChanges).toEqual(original.fullChanges);
    expect(store.snapshot.entries[0].publishedAt).toBe(original.publishedAt);
  });

  it('marks old summaries incomplete until full items are generated, including records outside the discovery window', async () => {
    const store = new MemoryStore();
    const old = entry();
    old.version = '2.1.200'; old.id = `claude-code-${hash('claude-code:cli:2.1.200').slice(0, 20)}`;
    old.sourceUrl = `${source.url}/tag/v2.1.200`; old.publishedAt = '2026-05-01T12:00:00Z'; old.publishedDate = '2026-05-01';
    delete old.fullChanges;
    store.snapshot.entries = [old];
    const expandChanges = vi.fn(async (value: Candidate) => details(value));
    const run = await collectOnce({ ...options(store), sinceDate: undefined, lookbackDays: 7, expandChanges });
    expect(run.status).toBe('success');
    expect(expandChanges).toHaveBeenCalledTimes(2);
    expect(store.snapshot.entries.find(value => value.id === old.id)?.fullChanges?.items).toHaveLength(56);
  });

  it('checkpoints polished partial items and preserves pending status when a later batch fails', async () => {
    const store = new MemoryStore();
    const run = await collectOnce({ ...options(store), expandChanges: async (value, _previous, onProgress) => {
      const full = details(value);
      await onProgress?.({ ...full, status: 'pending', items: full.items.slice(0, 12) });
      expect(store.writes.some(snapshot => snapshot.entries[0]?.fullChanges?.items.length === 12)).toBe(true);
      throw new Error('The next model batch is unavailable');
    } });
    expect(run.status).toBe('partial');
    expect(store.snapshot.entries[0].explanationStatus).toBe('ready');
    expect(store.snapshot.entries[0].fullChanges).toMatchObject({ status: 'pending', sourceCount: 56 });
    expect(store.snapshot.entries[0].fullChanges?.items).toHaveLength(12);
  });

  it('does not count a zero-generation-budget run as complete', async () => {
    const store = new MemoryStore();
    const expandChanges = vi.fn(async (value: Candidate) => details(value));
    const run = await collectOnce({ ...options(store), expandChanges, maxFullChanges: 0 });
    expect(run.status).toBe('partial');
    expect(expandChanges).not.toHaveBeenCalled();
    expect(store.snapshot.entries[0].fullChanges).toMatchObject({ status: 'pending', sourceCount: 56, items: [] });
  });

  it('invalidates the complete list when the official source changes', async () => {
    const store = new MemoryStore(); store.snapshot.entries = [entry()];
    const changedBody = `${body}\n- Fixed the final additional issue.`;
    const run = await collectOnce({ ...options(store), expandChanges: async value => details(value), maxFullChanges: 0,
      fetchDocument: async url => ({ url, body: release(changedBody), contentType: 'application/json' }) });
    expect(run.status).toBe('partial');
    expect(store.snapshot.entries[0].fullChanges).toMatchObject({ status: 'pending', sourceCount: 57, items: [] });
  });

  it('preserves complete current details against a later source check carrying only partial progress', () => {
    const current = { ...emptySnapshot(), entries: [entry()] };
    const incoming = structuredClone(current);
    incoming.entries[0].checkedAt = '2026-10-08T07:00:00Z';
    incoming.entries[0].fullChanges = { ...incoming.entries[0].fullChanges!, status: 'pending', items: incoming.entries[0].fullChanges!.items.slice(0, 8) };
    const merged = mergeImportedSnapshot(current, incoming);
    expect(merged.entries[0].fullChanges?.status).toBe('ready');
    expect(merged.entries[0].fullChanges?.items).toHaveLength(56);
  });

  it('combines all IDs while preserving newer corrected text from partial current data', () => {
    const current = { ...emptySnapshot(), entries: [entry()] };
    const incoming = structuredClone(current);
    current.entries[0].fullChanges = { ...current.entries[0].fullChanges!, status: 'pending',
      updatedAt: '2026-10-08T10:00:00Z', items: [{ ...current.entries[0].fullChanges!.items[0], text: '검토한 조건을 반영해 첫 번째 문제를 수정했습니다.' }] };
    incoming.entries[0].fullChanges!.updatedAt = '2026-10-08T09:00:00Z';
    const merged = mergeImportedSnapshot(current, incoming).entries[0].fullChanges!;
    expect(merged.status).toBe('ready');
    expect(merged.items).toHaveLength(56);
    expect(merged.items[0].text).toBe(current.entries[0].fullChanges.items[0].text);
    expect(merged.updatedAt).toBe(current.entries[0].fullChanges.updatedAt);
  });

  it('compares editing instants correctly when valid timestamps have different UTC offsets', () => {
    const current = { ...emptySnapshot(), entries: [entry()] };
    const incoming = structuredClone(current);
    current.entries[0].fullChanges!.updatedAt = '2026-10-08T19:00:00+09:00';
    incoming.entries[0].fullChanges!.updatedAt = '2026-10-08T10:30:00Z';
    incoming.entries[0].fullChanges!.items[0].text = '더 늦은 검토에서 첫 번째 조건을 바로잡았습니다.';
    expect(mergeImportedSnapshot(current, incoming).entries[0].fullChanges!.items[0].text)
      .toBe(incoming.entries[0].fullChanges!.items[0].text);
  });
});

describe('public full-change contract', () => {
  it('returns every item without exposing model, source hash or original source text', async () => {
    const value = entry(); const app = await server(value);
    for (const path of ['/api/feed', `/api/entries/${value.id}`]) {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(200);
      const visible = path === '/api/feed' ? response.json().entries[0] : response.json();
      expect(visible.fullChanges.items).toHaveLength(56);
      expect(visible.fullChanges.sourceHash).toBeUndefined();
      expect(visible.fullChanges.model).toBeUndefined();
      expect(response.body).not.toContain(DEFAULT_MODEL_ID);
      expect(response.body).not.toContain('Fixed issue 56');
    }
  });

  it('does not report a forged smaller item inventory as ready', async () => {
    const value = entry(); value.fullChanges!.sourceCount = 3; value.fullChanges!.items = value.fullChanges!.items.slice(0, 3);
    const app = await server(value);
    const visible = (await app.inject('/api/feed')).json().entries[0];
    expect(visible.fullChanges.status).toBe('pending');
    expect(visible.fullChanges.sourceCount).toBe(56);
  });

  it('never displays details from a different source version as current', async () => {
    const value = entry(); value.originalText += '\n- Fixed the newest issue.'; value.contentHash = hash(`${value.originalTitle}\n${value.originalText}`);
    const app = await server(value);
    const visible = (await app.inject('/api/feed')).json().entries[0];
    expect(visible.fullChanges).toMatchObject({ status: 'pending', sourceCount: 57, items: [] });
  });

  it('does not expose a rejected raw-source copy through a partial list', async () => {
    const value = entry();
    value.fullChanges!.items[0].text = `한국어 안내입니다. ${value.originalText}`;
    const app = await server(value);
    for (const path of ['/api/feed', `/api/entries/${value.id}`, '/feed.xml']) {
      const response = await app.inject(path);
      expect(response.body.includes('Fixed issue 56')).toBe(false);
      if (path !== '/feed.xml') {
        const visible = path === '/api/feed' ? response.json().entries[0] : response.json();
        expect(visible.fullChanges).toMatchObject({ status: 'pending', sourceCount: 56, items: [] });
      }
    }
  });

  it('includes the final item in RSS without private metadata', async () => {
    const app = await server(entry());
    const response = await app.inject('/feed.xml');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('변경 56의 조건');
    expect(response.body).not.toContain(DEFAULT_MODEL_ID);
    expect(response.body).not.toContain('sourceHash');
  });
});

describe('uncut source candidates', () => {
  const long = `${'- First change.\n'.repeat(2500)}- FINAL_CHANGE_MUST_SURVIVE.`;
  it('keeps the entire GitHub release body', () => expect(hash(parseGithubReleases(release(long), source)[0].originalText)).toBe(hash(long)));
  it('keeps the entire Codex RSS item body', () => {
    const feed = `<rss><channel><item><title>Codex update</title><link>https://developers.openai.com/codex/changelog/#test</link><pubDate>Wed, 07 Oct 2026 00:00:00 GMT</pubDate><description>${long}</description></item></channel></rss>`;
    expect(hash(parseCodexFeed(feed)[0].originalText)).toBe(hash(long));
  });
  it('keeps the entire Claude document update body', () => expect(hash(parseClaudeChangelog(`<Update label="2.1.293" description="2026-10-07">${long}</Update>`)[0].originalText)).toBe(hash(long)));
  it('keeps the tail of the Kiro timeline body', () => {
    const html = `<div data-timeline-item><time datetime="2026-10-07"></time><article><a href="/changelog/cli/2-28/"><h2>Kiro update</h2></a><p>${long}</p></article></div>`;
    expect(parseKiroChangelog(html)[0].originalText.includes('FINAL_CHANGE_MUST_SURVIVE.')).toBe(true);
  });
});
