import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const base = process.argv[2] ?? 'http://127.0.0.1:4196';
const output = process.argv[3] ?? 'docs/screenshots/reading-local';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const origin = new URL(base).origin;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await mkdir(output, { recursive: true });
  await page.goto(base, { waitUntil: 'networkidle' });
  const feed = await (await page.request.get(`${origin}/api/feed`)).json();
  assert.ok(feed.entries.length > 50);
  const ready = feed.entries.filter(entry => entry.explanationStatus === 'ready' && entry.explanation
    && Date.parse(entry.publishedAt) <= Date.now());
  const ordered = [...ready].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rss = {};
  for (const product of ['all', 'claude-code', 'codex', 'kiro']) {
    const path = `/feed.xml${product === 'all' ? '' : `?product=${product}`}`;
    const response = await page.request.get(`${origin}${path}`);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-type'], /application\/rss\+xml/);
    const xml = await response.text();
    assert.equal(XMLValidator.validate(xml), true);
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
    const items = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item].filter(Boolean);
    const expected = ordered.filter(entry => product === 'all' || entry.product === product).slice(0, 50);
    assert.deepEqual(items.map(item => new URL(item.link).searchParams.get('entry')), expected.map(entry => entry.id));
    for (let index = 0; index < items.length; index++) {
      assert.equal(new URL(items[index].link).origin, origin);
      assert.equal(items[index].guid['#text'], items[index].link);
      assert.equal(Date.parse(items[index].pubDate), Date.parse(expected[index].publishedAt));
      assert.ok(items[index].description.includes('AI 해설'));
    }
    rss[product] = items.length;
  }
  const first = feed.entries.find(entry => entry.explanationStatus === 'ready' && entry.version);
  assert.ok(first);
  const firstCard = () => page.locator(`[data-entry-id="${first.id}"]`);
  const firstLink = () => page.locator(`#entry-link-${first.id}`);
  await expect(firstLink()).toBeVisible();
  await firstLink().click();
  await expect(page.getByRole('button', { name: '읽지 않음으로 표시', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await expect(firstCard().locator('.read-badge')).toHaveText('읽음');
  await page.getByRole('button', { name: '읽지 않은 글만', exact: true }).click();
  await expect(firstCard()).toHaveCount(0);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: '읽지 않은 글만', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(firstCard()).toHaveCount(0);

  const filtered = new URL(base);
  filtered.search = new URLSearchParams({ product: first.product, q: first.version }).toString();
  await page.goto(filtered.href, { waitUntil: 'networkidle' });
  await firstLink().click();
  const previous = page.getByRole('navigation', { name: '같은 제품의 변경 기록' }).getByRole('link', { name: /이전 발표/ });
  await expect(previous).toBeVisible();
  const previousId = new URL(await previous.getAttribute('href'), base).searchParams.get('entry');
  const neighbor = feed.entries.find(entry => entry.id === previousId);
  assert.equal(neighbor.product, first.product);
  await previous.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(neighbor.explanation?.title ?? neighbor.originalTitle);
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await expect(page).toHaveURL(filtered.href);
  await expect(firstLink()).toBeFocused();

  await firstLink().click();
  await page.getByRole('button', { name: '읽지 않음으로 표시', exact: true }).click();
  await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
  await expect(page.getByRole('button', { name: '읽음으로 표시', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '글 저장', exact: true }).click();
  await page.getByRole('button', { name: '변경 기록으로 돌아가기', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(firstCard()).toBeVisible();
  await expect(firstCard().locator('.read-badge')).toHaveCount(0);
  const second = feed.entries.find(entry => entry.product !== first.product && entry.explanationStatus === 'ready');
  await page.goto(`${origin}/?entry=${encodeURIComponent(second.id)}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '글 저장', exact: true }).click();
  await page.goto(`${origin}/?saved=1&product=${first.product}`, { waitUntil: 'networkidle' });
  await expect(page.getByText('현재 필터에 맞는 저장 글 1개', { exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown 내보내기', exact: true }).click();
  const download = await downloading;
  assert.match(download.suggestedFilename(), /^code-pulse-saved-\d{4}-\d{2}-\d{2}\.md$/);
  const markdown = await readFile(await download.path(), 'utf8');
  assert.ok(markdown.includes('총 1개'));
  assert.ok(markdown.includes(`?entry=${encodeURIComponent(first.id)}`));
  assert.ok(!markdown.includes(`?entry=${encodeURIComponent(second.id)}`));
  assert.ok(markdown.includes(first.sourceUrl));
  await writeFile(`${output}/saved-export.md`, markdown);

  await page.getByRole('button', { name: 'RSS 구독', exact: true }).click();
  const subscription = page.getByRole('dialog', { name: 'RSS 구독', exact: true });
  await subscription.getByLabel('구독할 제품', { exact: true }).selectOption('kiro');
  await subscription.getByRole('button', { name: '구독 주소 복사', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}/feed.xml?product=kiro`);
  await subscription.getByRole('button', { name: '닫기', exact: true }).click();
  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: `서비스 변경 기록, 버전 ${version}`, exact: true })).toHaveText(`v${version}`);
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/mobile-dark.png`, fullPage: true });
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(), base, version, entries: feed.entries.length, rss,
    exportedEntries: 1, checks: ['RSS parsing and canonical URLs', 'product-specific RSS and original dates',
      'read persistence and unread filter', 'manual unread after rerender and reload', 'same-product adjacent records',
      'original list filters and focus', 'filtered saved Markdown download', 'RSS clipboard', '320px dark layout'],
    errors,
  };
  await writeFile(`${output}/reading-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
