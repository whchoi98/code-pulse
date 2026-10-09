import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Feed, FeedEntry, SearchIndex, StaticBootstrap } from '../../src/shared/types';
import { entryRevision } from '../../src/shared/reading-revision';
import { feed as legacyFeed, presence } from './fixtures';

function artifacts(count = 40) {
  const details: FeedEntry[] = Array.from({ length: count }, (_, index) => {
    const id = `cache-${String(index).padStart(3, '0')}`;
    const entry: FeedEntry = { ...legacyFeed.entries[1], id, language: 'ko', contentKind: 'explanation',
      detailUrl: `/content/objects/${id}.json`, checkedAt: '2026-10-09T00:00:00Z',
      explanation: { ...legacyFeed.entries[1].explanation!, title: `정적 변경 ${index}`, summary: `짧은 요약 ${index}` },
      fullChanges: { status: 'ready', sourceCount: 2, formatVersion: 'fixture', updatedAt: '2026-10-09T00:00:00Z',
        items: [{ id: 'first', text: `첫 변경 ${id}` }, { id: 'last', text: `마지막 전체 항목 ${id}${index === count - 1 ? ' finalneedle' : ''}` }] },
      changeSummary: { status: 'ready', sourceCount: 2, readyCount: 2 } };
    return { ...entry, readRevision: entryRevision(entry) };
  });
  const catalog: Feed = { ...legacyFeed, language: 'ko', generatedAt: '2026-10-09T00:00:00Z',
    schedule: { timezone: 'Asia/Seoul', hour: 7 }, searchUrl: '/content/objects/search-index.json',
    sources: legacyFeed.sources.map(source => ({ ...source, lastSuccessAt: '2026-10-09T00:00:00Z', checkedAt: '2026-10-09T00:00:00Z' })),
    entries: details.map(({ fullChanges: _full, ...entry }) => ({ ...entry,
      explanation: { ...entry.explanation!, whyItMatters: '', highlights: [], actionItems: [], audience: [] } })) };
  const index: SearchIndex = { language: 'ko', entries: details.map(entry => ({ id: entry.id,
    text: [entry.explanation!.title, ...entry.fullChanges!.items.map(item => item.text)].join(' ') })) };
  return { catalog, details, index };
}

async function mockStatic(page: Page, content: ReturnType<typeof artifacts>, bootstrap?: StaticBootstrap) {
  const requests: string[] = [];
  await page.clock.setFixedTime(new Date('2026-10-09T00:05:00Z'));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/content/') || path.startsWith('/api/feed') || path.startsWith('/api/entries')) requests.push(path);
  });
  await page.route('**/api/presence', route => route.fulfill({ json: presence }));
  await page.route('**/content/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/content/ko/feed.json') return route.fulfill({ json: content.catalog });
    if (path === content.catalog.searchUrl) return route.fulfill({ json: content.index });
    const detail = content.details.find(entry => entry.detailUrl === path);
    return detail ? route.fulfill({ json: detail }) : route.fulfill({ status: 404, json: {} });
  });
  if (bootstrap) {
    await page.route(url => url.pathname === '/', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('<div id="root"></div>', '<div id="root"><p>Server-rendered content</p></div>')
        .replace('</body>', `<template id="code-pulse-bootstrap">${JSON.stringify(bootstrap).replaceAll('<', '\\u003c')}</template></body>`);
      await route.fulfill({ response, body });
    });
  }
  return requests;
}

function card(page: Page, id: string) { return page.getByTestId('entry-card').filter({ has: page.locator(`#entry-link-${id}`) }); }
function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('deep-link bootstrap renders immediately without fetching that detail or flashing a loading state', async ({ page }) => {
  const content = artifacts(2);
  const requests = await mockStatic(page, content, { language: 'ko', detail: content.details[0] });
  const gate = held();
  await page.route('**/content/ko/feed.json', async route => { await gate.promise; await route.fulfill({ json: content.catalog }); });
  await page.addInitScript(() => {
    const flashes: string[] = [];
    Object.assign(window, { loadingFlashes: flashes });
    new MutationObserver(() => {
      const loading = document.querySelector('#root .loading-state');
      if (loading) flashes.push(loading.textContent ?? 'loading');
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/?entry=cache-000&lang=ko');
  await expect(page.getByRole('heading', { level: 1, name: '정적 변경 0' })).toBeVisible();
  await expect(page.locator('.full-change-item')).toHaveCount(2);
  expect(requests).toEqual(['/content/ko/feed.json']);
  expect(await page.evaluate(() => (window as unknown as { loadingFlashes: string[] }).loadingFlashes)).toEqual([]);
  gate.release();
  await expect(page.getByRole('navigation', { name: '같은 제품의 변경 기록' })).toBeVisible();
  expect(requests).toEqual(['/content/ko/feed.json']);
});

test('keeps a rendered deep link visible until the persisted different language detail is ready', async ({ page }) => {
  const content = artifacts(1);
  const requests = await mockStatic(page, content, { language: 'ko', detail: content.details[0] });
  const english: FeedEntry = { ...content.details[0], language: 'en', contentKind: 'source',
    detailUrl: '/content/objects/english-cache-000.json',
    explanation: { ...content.details[0].explanation!, title: 'English static release' } };
  const englishFeed: Feed = { ...content.catalog, language: 'en', entries: [{ ...english, fullChanges: undefined }] };
  await page.addInitScript(() => localStorage.setItem('code-pulse-language', 'en'));
  await page.route('**/content/en/feed.json', route => route.fulfill({ json: englishFeed }));
  const gate = held();
  await page.route('**/content/objects/english-cache-000.json', async route => {
    await gate.promise;
    await route.fulfill({ json: english });
  });
  await page.goto('/?entry=cache-000');
  await expect.poll(() => requests.includes(english.detailUrl!)).toBe(true);
  await expect(page.getByText('Server-rendered content', { exact: true })).toBeVisible();
  await expect(page.locator('.loading-state')).toHaveCount(0);
  gate.release();
  await expect(page.getByRole('heading', { level: 1, name: 'English static release' })).toBeVisible();
  expect(requests.filter(url => url === english.detailUrl)).toHaveLength(1);
  expect(requests.filter(url => url === '/content/en/feed.json')).toHaveLength(1);
});

test('prefetches only cards near the viewport and reopens a cached detail offline', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const content = artifacts(616);
  const requests = await mockStatic(page, content, { language: 'ko', feed: content.catalog });
  await page.goto('/?lang=ko');
  await expect(page.getByTestId('entry-card')).toHaveCount(20);
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  const nearby = await page.getByTestId('entry-card').evaluateAll(cards => cards.filter(card => {
    const rect = card.getBoundingClientRect();
    return rect.top <= window.innerHeight + 400 && rect.bottom >= -400;
  }).map(card => `/content/objects/${card.getAttribute('data-entry-id')}.json`));
  expect(requests.every(url => nearby.includes(url))).toBe(true);
  expect(requests.length).toBeLessThan(20);
  expect(requests).not.toContain('/content/ko/feed.json');
  await card(page, 'cache-015').scrollIntoViewIfNeeded();
  await expect.poll(() => requests.includes('/content/objects/cache-015.json')).toBe(true);
  await card(page, 'cache-015').getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: '정적 변경 15' })).toBeVisible();
  const loaded = requests.filter(url => url === '/content/objects/cache-015.json').length;
  await context.setOffline(true);
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await card(page, 'cache-015').getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: '정적 변경 15' })).toBeVisible();
  expect(requests.filter(url => url === '/content/objects/cache-015.json')).toHaveLength(loaded);
  expect(loaded).toBe(1);
});

test('waits for the complete debounced search index, shows errors, and reuses a successful retry', async ({ page }) => {
  const content = artifacts();
  const requests = await mockStatic(page, content, { language: 'ko', feed: content.catalog });
  const gate = held();
  await page.route('**/content/objects/search-index.json', async route => {
    await gate.promise;
    await route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/?lang=ko');
  const input = page.getByRole('searchbox', { name: '변경 기록 검색' });
  await input.fill('finalneedle');
  await expect(page.getByRole('status', { name: '불러오는 중' })).toContainText('전체 변경 기록에서 검색하고 있습니다');
  await expect(page.getByTestId('entry-card')).toHaveCount(0);
  await expect(page.getByText('조건에 맞는 글이 없습니다.', { exact: true })).toHaveCount(0);
  await expect.poll(() => requests.filter(url => url === content.catalog.searchUrl).length).toBe(1);
  gate.release();
  await expect(page.getByRole('alert')).toContainText('검색 자료를 불러오지 못했습니다.');
  await page.route('**/content/objects/search-index.json', route => route.fulfill({ json: content.index }));
  await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(card(page, 'cache-039')).toBeVisible();
  await input.fill('마지막 전체 항목 cache-038');
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(card(page, 'cache-038')).toBeVisible();
  expect(requests.filter(url => url === content.catalog.searchUrl)).toHaveLength(2);
});

test('starts a single complete-search request only after typing pauses for 250 milliseconds', async ({ page }) => {
  const content = artifacts();
  const requests = await mockStatic(page, content, { language: 'ko', feed: content.catalog });
  await page.clock.install({ time: new Date('2026-10-09T00:05:00Z') });
  await page.clock.pauseAt(new Date('2026-10-09T00:05:01Z'));
  await page.goto('/?lang=ko');
  const input = page.getByRole('searchbox', { name: '변경 기록 검색' });
  await input.fill('final');
  await page.clock.runFor(200);
  expect(requests.filter(url => url === content.catalog.searchUrl)).toHaveLength(0);
  await input.fill('finalneedle');
  await page.clock.runFor(249);
  expect(requests.filter(url => url === content.catalog.searchUrl)).toHaveLength(0);
  await page.clock.runFor(1);
  await expect.poll(() => requests.filter(url => url === content.catalog.searchUrl).length).toBe(1);
  await expect(card(page, 'cache-039')).toBeVisible();
});

test('exports complete details for saved entries beyond the first page without loading unselected records', async ({ page }) => {
  const content = artifacts();
  const selected = content.details.slice(0, 25).map(entry => entry.id);
  const requests = await mockStatic(page, content, { language: 'ko', feed: content.catalog });
  await page.addInitScript(ids => localStorage.setItem('code-pulse-saved', JSON.stringify(ids)), selected);
  await page.goto('/?lang=ko&saved=1');
  await expect(page.getByTestId('entry-card')).toHaveCount(20);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown 내보내기', exact: true }).click();
  const file = await downloaded;
  const markdown = await readFile((await file.path())!, 'utf8');
  for (const id of selected) expect(markdown).toContain(`마지막 전체 항목 ${id}`);
  const loaded = [...new Set(requests.filter(url => url.startsWith('/content/objects/')).map(url => url.split('/').at(-1)!.replace('.json', '')))];
  expect(loaded.sort()).toEqual(selected.sort());
  expect(requests.some(url => url.startsWith('/api/feed'))).toBe(false);
});

for (const restriction of ['saveData', 'slow-2g', 'offline', 'hidden'] as const) {
  test(`does not prefetch when ${restriction} is active but permits requested details`, async ({ page }) => {
    const content = artifacts(3);
    const requests = await mockStatic(page, content, { language: 'ko', feed: content.catalog });
    await page.addInitScript(restriction => {
      const connection = new EventTarget();
      Object.defineProperties(connection, {
        saveData: { get: () => restriction === 'saveData' },
        effectiveType: { get: () => restriction === 'slow-2g' ? 'slow-2g' : '4g' },
      });
      Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
      if (restriction === 'offline') Object.defineProperty(navigator, 'onLine', { get: () => false });
      if (restriction === 'hidden') Object.defineProperty(document, 'hidden', { get: () => true });
    }, restriction);
    await page.goto('/?lang=ko');
    await expect(page.getByTestId('entry-card')).toHaveCount(3);
    await card(page, 'cache-002').scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(requests).toEqual([]);
    await card(page, 'cache-002').getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: '정적 변경 2' })).toBeVisible();
    expect(requests).toEqual(['/content/objects/cache-002.json']);
  });
}

test('keeps an abandoned static response unread and retries errors without reading the old entry', async ({ page }) => {
  const content = artifacts(2);
  await mockStatic(page, content, { language: 'ko', feed: content.catalog });
  const gate = held();
  await page.route('**/content/objects/cache-000.json', async route => {
    await gate.promise;
    await route.fulfill({ json: content.details[0] }).catch(() => {});
  });
  await page.goto('/?lang=ko');
  await card(page, 'cache-000').getByRole('link').click();
  await expect(page.getByRole('status', { name: '불러오는 중' })).toBeVisible();
  await page.goBack();
  gate.release();
  await expect(card(page, 'cache-000')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('code-pulse-read:v1:cache-000'))).toBeNull();
  await card(page, 'cache-000').getByRole('link').click();
  await expect(page.getByRole('button', { name: '읽지 않음으로 표시', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '읽지 않음으로 표시', exact: true }).click();
  await page.getByRole('button', { name: '다크 모드로 전환' }).click();
  await expect(page.getByRole('button', { name: '읽음으로 표시', exact: true })).toBeVisible();
});

test('renders a pending static inventory as pending and does not mark it read', async ({ page }) => {
  const content = artifacts(1);
  content.details[0] = { ...content.details[0], explanationStatus: 'pending', explanation: undefined, fullChanges: undefined,
    changeSummary: { status: 'pending', sourceCount: 2, readyCount: 0 } };
  content.catalog.entries = content.details.map(({ fullChanges: _full, ...entry }) => entry);
  await mockStatic(page, content, { language: 'ko', feed: content.catalog });
  await page.goto('/?lang=ko&entry=cache-000');
  await expect(page.getByRole('heading', { name: '한국어 해설을 준비하고 있습니다.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('code-pulse-read:v1:cache-000'))).toBeNull();
});

test('refreshes checking metadata without reloading detail and fetches a new revision only on demand', async ({ page }) => {
  const content = artifacts(2);
  const requests = await mockStatic(page, content, { language: 'ko', feed: content.catalog, detail: content.details[0] });
  await page.goto('/?lang=ko&entry=cache-000');
  await expect(page.getByRole('button', { name: '읽지 않음으로 표시', exact: true })).toBeVisible();
  let next: Feed = { ...content.catalog, entries: content.catalog.entries.map(entry => ({ ...entry, checkedAt: '2026-10-09T00:07:00Z' })) };
  await page.route('**/content/ko/feed.json', route => route.fulfill({ json: next }));
  await page.clock.setFixedTime(new Date('2026-10-09T00:07:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => requests.filter(url => url === '/content/ko/feed.json').length).toBe(1);
  await expect(page.getByText('2026.10.09 09:07', { exact: false }).first()).toBeVisible();
  expect(requests.filter(url => url === '/content/objects/cache-000.json')).toEqual([]);
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await expect(card(page, 'cache-000').getByText('읽음', { exact: true })).toBeVisible();
  const revised = { ...content.details[0], readRevision: '0123456789abcdef', detailUrl: '/content/objects/revised-cache-000.json',
    fullChanges: { ...content.details[0].fullChanges!, items: [{ id: 'first', text: '첫 변경' }, { id: 'last', text: '수정된 전체 항목' }] } };
  next = { ...next, entries: next.entries.map(entry => entry.id === revised.id ? { ...entry, detailUrl: revised.detailUrl, readRevision: revised.readRevision } : entry) };
  await page.route('**/content/objects/revised-cache-000.json', route => route.fulfill({ json: revised }));
  await page.clock.setFixedTime(new Date('2026-10-09T00:09:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => requests.filter(url => url === '/content/ko/feed.json').length).toBe(2);
  await expect(card(page, 'cache-000').getByText('읽음', { exact: true })).toHaveCount(0);
  await card(page, 'cache-000').getByRole('link').click();
  await expect(page.locator('.full-change-item').last()).toHaveText('수정된 전체 항목');
  expect(requests.filter(url => url === revised.detailUrl)).toHaveLength(1);
});
