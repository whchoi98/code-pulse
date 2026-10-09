import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'cheerio';
import { afterEach, describe, expect, it } from 'vitest';
import { extractChangeItems } from '../src/collector/change-items.js';
import { DEFAULT_MODEL_ID } from '../src/collector/explanation.js';
import { FULL_CHANGES_VERSION, fullChangesSourceHash } from '../src/collector/full-changes.js';
import { emptySnapshot, FileStore, WriteConflict } from '../src/collector/store.js';
import { buildPublicContent, renderPage, publishSite, LocalSiteTarget } from '../src/publishing/index.js';
import type { SiteAsset, SiteTarget, StoredSiteAsset } from '../src/publishing/index.js';
import type { Entry, Feed, Snapshot, StaticBootstrap } from '../src/shared/types.js';

const clock = new Date('2026-10-09T00:00:00Z');
const shell = '<!doctype html><html lang="ko"><head><title>Code Pulse</title><link rel="stylesheet" href="/assets/app-123.css"><script type="module" src="/assets/app-123.js"></script></head><body><div id="root"></div></body></html>';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fixture(): Snapshot {
  const entry: Entry = {
    id: 'claude-test', product: 'claude-code', channel: 'cli', sourceId: 'claude-releases', version: '2.0.1',
    originalTitle: 'Official release', originalText: '## Features\n- Added `--stable` for command execution.\n## Fixes\n- Fixed reconnect cleanup.',
    sourceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.0.1', references: [],
    publishedAt: '2026-10-08T18:00:00Z', publishedDate: '2026-10-08', datePrecision: 'timestamp',
    firstSeenAt: '2026-10-09T00:00:00Z', checkedAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
    contentHash: 'PRIVATE_CONTENT_HASH', explanationModel: DEFAULT_MODEL_ID, explanationStatus: 'ready',
    explanation: { title: '명령 실행 설정을 추가했습니다', summary: '실행 설정과 연결 종료 동작을 개선했습니다.',
      whyItMatters: '검색전용깊은문구로 복구 동작을 확인합니다.', actionItems: ['실행 설정을 확인하세요.'], audience: ['CLI 사용자'],
      category: 'feature', impact: 'medium', highlights: [{ title: '명령 실행', detail: '실행 설정을 추가했습니다.', evidence: 'Added `--stable`' }] },
  };
  entry.fullChanges = {
    status: 'ready', sourceHash: fullChangesSourceHash(entry), model: DEFAULT_MODEL_ID, formatVersion: FULL_CHANGES_VERSION,
    updatedAt: entry.updatedAt, sourceCount: 2, items: extractChangeItems(entry).map((item, index) => ({ id: item.id,
      text: index ? '재연결 후 세션을 정리하는 오류를 고쳤습니다.' : '명령 실행에 `--stable` 설정을 추가했습니다.' })),
  };
  return { ...emptySnapshot(), generatedAt: clock.toISOString(), entries: [entry],
    sources: [{ id: 'claude-releases', product: 'claude-code', name: 'Claude Code releases', url: entry.sourceUrl,
      state: 'ok', checkedAt: entry.checkedAt, lastSuccessAt: entry.checkedAt, entryCount: 1 }],
  };
}

async function localFixture(snapshot = fixture()) {
  const directory = await mkdtemp(join(tmpdir(), 'code-pulse-publication-'));
  directories.push(directory);
  const staticDirectory = join(directory, 'build');
  await mkdir(join(staticDirectory, 'assets'), { recursive: true });
  await writeFile(join(staticDirectory, 'index.html'), shell);
  await writeFile(join(staticDirectory, 'assets/app-123.js'), 'console.log("ready");');
  await writeFile(join(staticDirectory, 'assets/app-123.css'), '.entry-card { color: black; }');
  const store = new FileStore(join(directory, 'data'));
  await store.write(snapshot);
  const target = new LocalSiteTarget(join(directory, 'site'));
  return { directory, staticDirectory, store, target, options: { staticDirectory, now: () => clock } };
}

function decodeObject(content: ReturnType<typeof buildPublicContent>, url: string) {
  return JSON.parse(content.objects.get(url.slice(1))!.body.toString());
}

describe('bilingual static content', () => {
  it('sets RSS autodiscovery to the rendered page language', () => {
    const withRss = shell.replace('</head>', '<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>');
    const content = buildPublicContent(fixture(), clock);
    for (const language of ['ko', 'en'] as const) {
      const html = load(renderPage(withRss, { language, feed: content.feeds[language] }));
      expect(html('link[type="application/rss+xml"]').attr('href')).toBe(`/feed.xml?lang=${language}`);
    }
  });
  it('publishes every source item in order and shares the existing Korean reader revision', () => {
    const snapshot = fixture();
    const content = buildPublicContent(snapshot, clock);
    const ko = decodeObject(content, content.feeds.ko.entries[0].detailUrl!);
    const en = decodeObject(content, content.feeds.en.entries[0].detailUrl!);
    expect(ko.fullChanges.items).toEqual(snapshot.entries[0].fullChanges!.items);
    expect(en.fullChanges.items).toEqual([
      { id: snapshot.entries[0].fullChanges!.items[0].id, text: 'Features\n\nAdded `--stable` for command execution.' },
      { id: snapshot.entries[0].fullChanges!.items[1].id, text: 'Fixes\n\nFixed reconnect cleanup.' },
    ]);
    expect(en.contentKind).toBe('source');
    expect(en.explanation.title).toBe('Official release');
    expect(en.explanation.whyItMatters).toBe('');
    expect(en.explanation.highlights).toEqual([]);
    expect(en.explanation.actionItems).toEqual([]);
    expect(en.explanation.audience).toEqual([]);
    expect(ko.readRevision).toMatch(/^[a-f0-9]{16}$/);
    expect(en.readRevision).toBe(ko.readRevision);
    for (const body of [...content.objects.values()].map(object => object.body.toString())) {
      expect(body).not.toMatch(/"(?:originalText|contentHash|sourceHash|explanationModel|model)"\s*:/);
      expect(body).not.toContain('PRIVATE_CONTENT_HASH');
      expect(body).not.toContain(DEFAULT_MODEL_ID);
    }
  });

  it('keeps catalogs compact but indexes complete secondary and final-item text', () => {
    const content = buildPublicContent(fixture(), clock);
    for (const language of ['ko', 'en'] as const) {
      const entry = content.feeds[language].entries[0];
      expect(entry.fullChanges).toBeUndefined();
      expect(entry.explanation!.whyItMatters).toBe('');
      expect(entry.explanation!.highlights).toEqual([]);
      expect(entry.changeSummary).toEqual({ status: 'ready', sourceCount: 2, readyCount: 2 });
      expect(entry.detailUrl).toMatch(/^\/content\/objects\/[a-f0-9]{64}\.json$/);
      expect(entry.detailBytes).toBe(content.objects.get(entry.detailUrl!.slice(1))!.body.byteLength);
      expect(content.feeds[language].schedule).toEqual({ hour: 7, timezone: 'Asia/Seoul' });
    }
    const index = decodeObject(content, content.feeds.ko.searchUrl!);
    expect(index.entries[0].text).toContain('검색전용깊은문구');
    expect(index.entries[0].text).toContain('재연결 후 세션을 정리하는 오류');
    expect(JSON.stringify(content.feeds.ko)).not.toContain('검색전용깊은문구');
    expect(decodeObject(content, content.feeds.en.searchUrl!).entries[0].text).toContain('Fixed reconnect cleanup.');
  });

  it('does not invalidate detail URLs or read markers on successful rechecks alone', () => {
    const snapshot = fixture();
    const before = buildPublicContent(snapshot, clock);
    snapshot.entries[0].checkedAt = '2026-10-10T00:00:00Z';
    snapshot.sources[0].checkedAt = snapshot.entries[0].checkedAt;
    snapshot.generatedAt = snapshot.entries[0].checkedAt;
    const after = buildPublicContent(snapshot, clock);
    for (const language of ['ko', 'en'] as const) {
      expect(after.feeds[language].entries[0].detailUrl).toBe(before.feeds[language].entries[0].detailUrl);
      expect(after.feeds[language].entries[0].readRevision).toBe(before.feeds[language].entries[0].readRevision);
      expect(after.feeds[language].entries[0].checkedAt).toBe('2026-10-10T00:00:00Z');
    }
  });

  it('gives English readers English generated source labels while preserving source URLs and Korean-source context', () => {
    const snapshot = fixture();
    snapshot.sources[0].name = 'Claude Code 새 소식 (한국어 주간 요약)';
    snapshot.entries[0].references = [{ title: 'Codex 공식 GitHub 릴리스', url: 'https://github.com/openai/codex/releases', kind: 'release' }];
    const content = buildPublicContent(snapshot, clock);
    const detail = decodeObject(content, content.feeds.en.entries[0].detailUrl!);
    expect(detail.references[0]).toEqual({ title: 'Codex official GitHub releases', url: 'https://github.com/openai/codex/releases', kind: 'release' });
    expect(content.feeds.en.sources[0].name).toBe("Claude Code What's new (Korean weekly summary)");
    expect(content.feeds.ko.sources[0].name).toBe('Claude Code 새 소식 (한국어 주간 요약)');
  });

  it('retains previous records and marks partial Korean inventories explicitly after source errors', () => {
    const snapshot = fixture();
    snapshot.sources[0].state = 'error';
    snapshot.entries[0].fullChanges!.status = 'pending';
    snapshot.entries[0].fullChanges!.items.pop();
    const content = buildPublicContent(snapshot, clock);
    expect(content.feeds.ko.entries).toHaveLength(1);
    expect(content.feeds.ko.entries[0].changeSummary).toEqual({ status: 'pending', sourceCount: 2, readyCount: 1 });
    expect(content.feeds.en.entries[0].changeSummary).toEqual({ status: 'ready', sourceCount: 2, readyCount: 2 });
    expect(content.feeds.ko.sources[0].state).toBe('error');
  });

  it('renders styled readable pages and escapes bootstrap data without embedding a catalog per detail', () => {
    const snapshot = fixture();
    snapshot.entries[0].explanation!.title = '</template><script>alert("x")</script>& title';
    const content = buildPublicContent(snapshot, clock);
    const feed = content.feeds.ko;
    const detail = { ...decodeObject(content, feed.entries[0].detailUrl!), ...feed.entries[0],
      explanation: decodeObject(content, feed.entries[0].detailUrl!).explanation,
      fullChanges: decodeObject(content, feed.entries[0].detailUrl!).fullChanges };
    const page = renderPage(shell, { language: 'ko', detail });
    const $ = load(page);
    expect($('#root h1').text()).toBe(snapshot.entries[0].explanation!.title);
    expect($('#root .full-changes li')).toHaveLength(2);
    expect($('#root script')).toHaveLength(0);
    expect($('link[rel="stylesheet"]').attr('href')).toBe('/assets/app-123.css');
    expect($('script[src="/assets/app-123.js"]')).toHaveLength(1);
    const bootstrap = JSON.parse($('#code-pulse-bootstrap').html()!) as StaticBootstrap;
    expect(bootstrap.detail?.id).toBe('claude-test');
    expect(bootstrap.feed).toBeUndefined();
    expect(bootstrap.detail?.explanation!.title).toBe(snapshot.entries[0].explanation!.title);
    expect(page).toContain('lang=en&amp;entry=claude-test');
    const listing = load(renderPage(shell, { language: 'en', feed: content.feeds.en }));
    expect(listing('html').attr('lang')).toBe('en');
    expect(listing('#root .entry-card')).toHaveLength(1);
    expect(listing('#root .entry-card h3 a').attr('href')).toBe('/?lang=en&entry=claude-test');
  });

  it('renders only the initial twenty cards while retaining every remaining article link without JavaScript', () => {
    const snapshot = fixture();
    snapshot.entries = Array.from({ length: 25 }, (_, index) => ({ ...structuredClone(snapshot.entries[0]), id: `entry-${index}` }));
    const { feeds } = buildPublicContent(snapshot, clock);
    const $ = load(renderPage(shell, { language: 'en', feed: feeds.en }), { scriptingEnabled: false });
    expect($('#root .entry-card')).toHaveLength(20);
    expect($('#root noscript a')).toHaveLength(5);
    expect(JSON.parse($('#code-pulse-bootstrap').html()!).feed.entries).toHaveLength(25);
  });
});

describe('safe publication', () => {
  it('publishes dependencies before pages and catalogs, and skips unchanged publication writes', async () => {
    const { target, store, options } = await localFixture();
    let writes = 0;
    const observed: SiteTarget = {
      read: key => target.read(key),
      put: async (asset, expected) => {
        writes++;
        if (asset.key.startsWith('pages/') || /content\/(ko|en)\/feed.json/.test(asset.key)) {
          const content = buildPublicContent((await store.read()).snapshot, clock);
          for (const key of content.objects.keys()) expect(await target.read(key)).toBeDefined();
          if (asset.key.startsWith('pages/')) {
            const page = load(asset.body.toString());
            expect(await target.read(page('script[type="module"]').attr('src')!.slice(1))).toBeDefined();
          }
        }
        return target.put(asset, expected);
      },
    };
    const first = await publishSite(store, observed, options);
    expect(first.status).toBe('published');
    expect(first.records).toBe(1);
    expect((await target.read('robots.txt'))!.body.toString()).toBe('User-agent: *\nAllow: /\n');
    const feed = JSON.parse((await target.read('content/ko/feed.json'))!.body.toString()) as Feed;
    expect((await target.read(feed.entries[0].detailUrl!.slice(1)))?.body.length).toBe(feed.entries[0].detailBytes);
    const count = writes;
    const second = await publishSite(store, observed, options);
    expect(second.status).toBe('unchanged');
    expect(writes).toBe(count);
  });

  it('keeps the prior catalog and detail accessible when a dependency upload fails', async () => {
    const { target, store, options } = await localFixture();
    await publishSite(store, target, options);
    const prior = (await target.read('content/ko/feed.json'))!.body;
    const current = await store.read();
    current.snapshot.generatedAt = '2026-10-09T01:00:00Z';
    current.snapshot.entries[0].explanation!.summary = '새 요약입니다.';
    await store.write(current.snapshot, current.etag);
    const failed: SiteTarget = { read: key => target.read(key), put: async (asset, expected) => {
      if (asset.key.startsWith('content/objects/')) throw new Error('upload interrupted');
      return target.put(asset, expected);
    } };
    await expect(publishSite(store, failed, options)).rejects.toThrow('upload interrupted');
    expect((await target.read('content/ko/feed.json'))!.body.equals(prior)).toBe(true);
    const previousFeed = JSON.parse(prior.toString()) as Feed;
    expect(await target.read(previousFeed.entries[0].detailUrl!.slice(1))).toBeDefined();
  });

  it('refuses catalog promotion when the source snapshot changed during preparation', async () => {
    const { target, store, options } = await localFixture();
    let changed = false;
    const racing: SiteTarget = { read: key => target.read(key), put: async (asset, expected) => {
      const result = await target.put(asset, expected);
      if (!changed && asset.key.startsWith('content/objects/')) {
        changed = true;
        const current = await store.read();
        await store.write({ ...current.snapshot, generatedAt: '2026-10-09T01:00:00Z' }, current.etag);
      }
      return result;
    } };
    await expect(publishSite(store, racing, options)).rejects.toBeInstanceOf(WriteConflict);
    expect(await target.read('content/ko/feed.json')).toBeUndefined();
  });

  it('prevents an older publisher paused before a page write from overwriting a completed newer site', async () => {
    const { target, store, options } = await localFixture();
    await publishSite(store, target, options);
    const first = await store.read();
    first.snapshot.generatedAt = '2026-10-09T01:00:00Z';
    first.snapshot.entries[0].explanation!.summary = '오래된 실행의 중간 요약입니다.';
    await store.write(first.snapshot, first.etag);
    let release!: () => void;
    let paused!: () => void;
    const ready = new Promise<void>(resolve => { paused = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const slow: SiteTarget = { read: key => target.read(key), put: async (asset, expected) => {
      if (!held && asset.key === 'pages/ko/claude-test.html') { held = true; paused(); await gate; }
      return target.put(asset, expected);
    } };
    const oldResult = publishSite(store, slow, options).catch(error => error);
    await ready;
    const second = await store.read();
    second.snapshot.generatedAt = '2026-10-09T02:00:00Z';
    second.snapshot.entries[0].explanation!.summary = '최신 실행의 확정 요약입니다.';
    await store.write(second.snapshot, second.etag);
    await publishSite(store, target, options);
    release();
    expect(await oldResult).toBeInstanceOf(WriteConflict);
    expect((await target.read('pages/ko/claude-test.html'))!.body.toString()).toContain('최신 실행의 확정 요약입니다.');
    expect((await target.read('content/ko/feed.json'))!.body.toString()).toContain('최신 실행의 확정 요약입니다.');
  });

  it('refuses an empty snapshot instead of replacing a previously working catalog', async () => {
    const { target, store, options } = await localFixture();
    await publishSite(store, target, options);
    const prior = (await target.read('content/ko/feed.json'))!.body;
    const current = await store.read();
    await store.write({ ...current.snapshot, generatedAt: '2026-10-09T01:00:00Z', entries: [] }, current.etag);
    await expect(publishSite(store, target, options)).rejects.toThrow(/empty/i);
    expect((await target.read('content/ko/feed.json'))!.body.equals(prior)).toBe(true);
  });

  it('versions fixed assets and nested font dependencies so new builds preserve the prior assets', async () => {
    const { target, store, staticDirectory, options } = await localFixture();
    await mkdir(join(staticDirectory, 'fonts'));
    await writeFile(join(staticDirectory, 'fonts/type.woff2'), 'font v1');
    await writeFile(join(staticDirectory, 'fonts/fonts.css'), '@font-face{src:url(/fonts/type.woff2)}');
    await writeFile(join(staticDirectory, 'theme.js'), 'document.documentElement.dataset.theme="light";');
    await writeFile(join(staticDirectory, 'index.html'), shell.replace('</head>', '<link rel="stylesheet" href="/fonts/fonts.css"><script src="/theme.js"></script></head>'));
    await publishSite(store, target, options);
    const before = load((await target.read('pages/en/index.html'))!.body.toString());
    const oldTheme = before('script:not([type])').attr('src')!;
    const oldFonts = before('link[rel="stylesheet"]').last().attr('href')!;
    expect(oldTheme).toMatch(/^\/assets\/[a-z0-9-]+\.js$/);
    expect(oldTheme).not.toBe('/theme.js');
    const fontCss = (await target.read(oldFonts.slice(1)))!.body.toString();
    expect(fontCss).not.toContain('/fonts/type.woff2');
    const fontUrl = fontCss.match(/url\(([^)]+)\)/)![1];
    expect((await target.read(fontUrl.slice(1)))!.body.toString()).toBe('font v1');
    await writeFile(join(staticDirectory, 'theme.js'), 'document.documentElement.dataset.theme="dark";');
    await publishSite(store, target, options);
    const after = load((await target.read('pages/en/index.html'))!.body.toString());
    expect(after('script:not([type])').attr('src')).not.toBe(oldTheme);
    expect((await target.read(oldTheme.slice(1)))!.body.toString()).toContain('light');
  });
});
