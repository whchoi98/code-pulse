import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://127.0.0.1:4187';
const output = process.argv[3] ?? 'docs/screenshots';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  const response = await page.goto(base, { waitUntil: 'networkidle' });
  expect(response.status()).toBe(200);
  if (base.startsWith('https:')) expect(response.url().startsWith('https:')).toBe(true);
  expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
  const feedResponse = await page.request.get(new URL('/api/feed', base).href);
  expect(feedResponse.status()).toBe(200);
  const feed = await feedResponse.json();
  expect(feed.entries.length).toBeGreaterThan(0);
  expect(feed.entries.every(entry => entry.explanationStatus === 'ready' && entry.explanation)).toBe(true);
  expect(new Set(feed.entries.map(entry => entry.product)).size).toBe(3);
  expect(feed.entries.every(entry => !('originalText' in entry) && !('contentHash' in entry)
    && !('background' in entry) && !('explanationModel' in entry))).toBe(true);
  expect(feed.sources.map(source => source.id).sort()).toEqual([
    'claude-changelog', 'claude-releases', 'claude-whats-new', 'codex-changelog', 'codex-releases', 'kiro-changelog',
  ]);
  expect(feed.sources.every(source => source.state === 'ok')).toBe(true);
  expect(feed.sources.find(source => source.id === 'claude-whats-new').latestPublishedDate).toBeUndefined();
  expect(feed.entries.every(entry => entry.publishedDate >= '2026-01-01' && Date.parse(entry.publishedAt) <= Date.now())).toBe(true);
  const januaryEntries = feed.entries.filter(entry => entry.publishedDate.startsWith('2026-01'));
  expect(new Set(januaryEntries.map(entry => entry.product)).size).toBe(3);
  const links = page.locator('a[id^="entry-link-"]');
  await expect(links.first()).toBeVisible();
  await expect(page.locator('.presence-wrap')).toHaveAttribute('data-presence-state', 'live');
  await expect(page.getByRole('status', { name: '방문 집계' })).toContainText('누적 방문');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const versionButton = page.getByRole('button', { name: `서비스 변경 기록, 버전 ${version}` });
  await expect(versionButton).toHaveText(`v${version}`);
  await versionButton.click();
  const releaseDialog = page.getByRole('dialog', { name: 'Code Pulse 변경 기록' });
  await expect(releaseDialog).toContainText(`v${version}`);
  await expect(releaseDialog).toContainText('Claude Haiku 5.5');
  await releaseDialog.getByRole('button', { name: '닫기', exact: true }).click();
  const logoImages = page.getByRole('group', { name: '제품 필터' }).locator('img');
  await expect(logoImages).toHaveCount(3);
  const logos = await logoImages.evaluateAll(images => images.map(image => new URL(image.currentSrc).pathname).sort());
  expect(logos).toEqual(['/brand/claude-code.png', '/brand/codex.png', '/brand/kiro.svg']);
  const loadedLogos = () => page.locator('.product-mark img').evaluateAll(images =>
    images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0
      && new URL(image.currentSrc).origin === window.location.origin));
  await expect.poll(loadedLogos).toBe(true);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.locator('.site-footer').screenshot({ path: `${output}/footer.png` });
  await page.getByRole('button', { name: '출처별 확인 상태' }).click();
  const sourceDialog = page.getByRole('dialog', { name: '공식 출처와 수집 상태' });
  await expect(sourceDialog.locator('.source-item')).toHaveCount(6);
  for (const url of ['https://code.claude.com/docs/en/changelog', 'https://code.claude.com/docs/ko/whats-new']) {
    await expect(sourceDialog.locator(`a[href="${url}"]`)).toBeVisible();
  }
  await sourceDialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.goto(new URL('/?from=2026-01-01&to=2026-01-31', base).href, { waitUntil: 'networkidle' });
  await expect(links).toHaveCount(Math.min(20, januaryEntries.length));
  const januaryIds = new Set(januaryEntries.map(entry => entry.id));
  const visibleJanuaryIds = await links.evaluateAll(anchors => anchors.map(anchor => new URL(anchor.href).searchParams.get('entry')));
  expect(visibleJanuaryIds.every(id => januaryIds.has(id))).toBe(true);
  await page.goto(base, { waitUntil: 'networkidle' });
  const search = page.getByPlaceholder('기능, 키워드, 버전으로 검색');
  await search.fill('Haiku');
  await expect(links.first()).toContainText('Haiku');
  await search.fill('');
  await expect(links).toHaveCount(Math.min(20, feed.entries.length));
  const href = await links.first().getAttribute('href');
  const id = new URL(href, base).searchParams.get('entry');
  const selected = feed.entries.find(entry => entry.id === id);
  await links.first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(selected.explanation?.title ?? selected.originalTitle);
  const save = page.getByRole('button', { name: '글 저장', exact: true });
  await save.click();
  await expect(page.getByRole('button', { name: '저장 해제', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const externalLinks = await page.locator('a[target="_blank"]').evaluateAll(anchors => anchors.map(anchor => ({ href: anchor.href, rel: anchor.rel })));
  expect(externalLinks.length).toBeGreaterThan(0);
  expect(externalLinks.every(link => link.href.startsWith('https:') && link.rel.includes('noopener'))).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({ path: `${output}/mobile-detail.png`, fullPage: true });
  await page.getByRole('button', { name: /다크 모드/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(loadedLogos).toBe(true);
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({ path: `${output}/mobile-dark.png`, fullPage: true });
  expect(errors).toEqual([]);
  const report = {
    base, checkedAt: new Date().toISOString(), https: response.url().startsWith('https:'), entries: feed.entries.length,
    products: [...new Set(feed.entries.map(entry => entry.product))], stale: feed.stale,
    januaryEntries: januaryEntries.length, historySince: '2026-01-01',
    logos, sourceIds: feed.sources.map(source => source.id), version,
    checks: ['HTTP 200 and security headers', 'real feed from all products', 'source body and background privacy',
      'official logos in both themes', 'six healthy official sources', 'requested Claude documentation links',
      'live visitor counts', 'manifest version and application release notes',
      'January history and date filtering for all three products', 'search', 'detail', 'bookmark', 'official links', 'mobile overflow', 'dark mode', 'browser errors'],
    errors,
  };
  await writeFile(`${output}/browser-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
