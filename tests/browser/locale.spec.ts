import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Feed, FeedEntry, Language } from '../../src/shared/types';
import { entries, feed, presence } from './fixtures';

// Invented interaction fixtures, with full details kept outside the compact feed.
const inventory = Array.from({ length: 56 }, (_, index) => ({
  id: `source-item-${index + 1}`,
  text: index === 55 ? 'Removed orphan-session markers after shutdown.'
    : index === 52 ? 'Detached-window recovery waits for workspace approval.'
      : `Official change ${index + 1}: preserve workspace settings and approval boundaries.`,
}));

const details = (language: Language): FeedEntry[] => feed.entries.map((entry, index) => ({
  ...entry,
  language,
  contentKind: language === 'en' ? 'source' : 'explanation',
  readRevision: `${index + 1}`.repeat(16),
  detailUrl: `/content/objects/${`${index + (language === 'en' ? 5 : 1)}`.repeat(64)}.json`,
  ...(language === 'en' ? {
    explanationStatus: 'ready' as const,
    explanation: {
      title: entry.originalTitle,
      summary: entries[index].originalText,
      category: entry.explanation?.category ?? 'improvement',
      impact: 'low' as const,
      whyItMatters: '', highlights: [], actionItems: [], audience: [],
    },
  } : {}),
  fullChanges: {
    status: 'ready', sourceCount: 56, formatVersion: 'fixture-v1',
    updatedAt: '2026-10-07T00:10:00Z',
    items: language === 'en' ? inventory : inventory.map(item => ({ ...item, text: `작업 공간 설정과 승인 범위를 유지합니다. ${item.id}` })),
  },
}));

async function mockBilingual(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-07T03:00:00Z'));
  await page.route('**/api/presence', route => route.fulfill({ json: presence }));
  await page.route('**/api/feed', route => route.fulfill({ json: { ...feed, entries: details('ko') } }));
  await page.route('**/api/entries/*', route => {
    const url = new URL(route.request().url());
    const entry = details(url.searchParams.get('lang') === 'en' ? 'en' : 'ko').find(item => item.id === url.pathname.split('/').pop());
    return entry ? route.fulfill({ json: entry }) : route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  for (const language of ['ko', 'en'] as const) {
    const records = details(language);
    const searchUrl = `/content/objects/${language === 'en' ? 'e'.repeat(64) : 'a'.repeat(64)}.json`;
    const catalog: Feed = {
      ...feed, language, searchUrl, schedule: { timezone: 'Asia/Seoul', hour: 7 },
      entries: records.map(({ fullChanges, explanation, ...entry }) => ({
        ...entry,
        explanation: explanation && { ...explanation, whyItMatters: '', highlights: [], actionItems: [], audience: [] },
        changeSummary: { status: 'ready', sourceCount: fullChanges!.sourceCount, readyCount: fullChanges!.items.length },
      })),
    };
    await page.route(`**/content/${language}/feed.json`, route => route.fulfill({ json: catalog }));
    await page.route(`**${searchUrl}`, route => route.fulfill({ json: {
      language,
      entries: records.map(entry => ({ id: entry.id, text: [entry.originalTitle, entry.explanation?.summary, ...entry.fullChanges!.items.map(item => item.text)].join(' ') })),
    } }));
    for (const entry of records) {
      await page.route(`**${entry.detailUrl}`, route => route.fulfill({ json: entry }));
    }
  }
}

test.beforeEach(async ({ page }) => {
  await mockBilingual(page);
});

test('RSS autodiscovery follows each language switch', async ({ page }) => {
  await page.goto('/?lang=en');
  const rss = page.locator('link[type="application/rss+xml"]');
  await expect(rss).toHaveAttribute('href', '/feed.xml?lang=en');
  await page.locator('header').getByRole('button', { name: '한국어', exact: true }).click();
  await expect(rss).toHaveAttribute('href', '/feed.xml?lang=ko');
});

test('switching languages preserves the entry, filters, saved state and manual unread choice', async ({ page }) => {
  await page.goto('/?product=claude-code&category=feature&q=workspace&from=2026-10-01&to=2026-10-07&saved=1&unread=1&entry=claude-latest');
  await page.getByRole('button', { name: '글 저장', exact: true }).click();
  await page.getByRole('button', { name: '읽지 않음으로 표시', exact: true }).click();
  const languageButtons = page.locator('header').getByRole('group', { name: /Language|언어/ });
  await expect(languageButtons).toBeVisible();
  await languageButtons.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('article', { name: 'Claude Code 2.1.0' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unsave article', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Mark as read', exact: true })).toBeVisible();
  const params = new URL(page.url()).searchParams;
  expect(Object.fromEntries(params)).toEqual({ product: 'claude-code', category: 'feature', q: 'workspace', from: '2026-10-01', to: '2026-10-07', saved: '1', unread: '1', entry: 'claude-latest', lang: 'en' });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('code-pulse-language'))).toBe('en');
  await languageButtons.getByRole('button', { name: '한국어', exact: true }).click();
  await expect(page.getByRole('article', { name: entries[1].explanation!.title })).toBeVisible();
  await expect(page.getByRole('button', { name: '읽음으로 표시', exact: true })).toBeVisible();
});

test('explicit English links override saved language and shared links retain English', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => { if (!localStorage.getItem('code-pulse-language')) localStorage.setItem('code-pulse-language', 'ko'); });
  await page.goto('/?lang=en&entry=claude-latest&q=private-filter&saved=1');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('Claude Code 2.1.0 | Code Pulse');
  await page.getByRole('button', { name: 'Copy article link', exact: true }).click();
  const shared = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(Object.fromEntries(shared.searchParams)).toEqual({ entry: 'claude-latest', lang: 'en' });
  await page.locator('header').getByRole('button', { name: '한국어', exact: true }).click();
  await page.locator('header').getByRole('button', { name: 'English', exact: true }).click();
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('searchbox', { name: 'Search changes' })).toBeVisible();
  await page.goto('/?lang=ko');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('searchbox', { name: '변경 기록 검색' })).toBeVisible();
});

test('an explicit Korean view keeps its language on home navigation over an English preference', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('code-pulse-language', 'en'));
  await page.goto('/?lang=ko&entry=claude-latest');
  await expect(page.getByRole('article', { name: entries[1].explanation!.title })).toBeVisible();
  await page.getByRole('link', { name: 'Code Pulse 홈', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('searchbox', { name: '변경 기록 검색' })).toBeVisible();
});

test('English details contain every source item and English dialogs without AI-only sections', async ({ page }) => {
  await page.goto('/?lang=en&entry=claude-latest');
  await expect(page.getByRole('article', { name: 'Claude Code 2.1.0' })).toBeVisible();
  await expect(page.getByText('Official source', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.full-change-item')).toHaveCount(56);
  await expect(page.locator('.full-change-item').last()).toHaveText('Removed orphan-session markers after shutdown.');
  await expect(page.locator('.why-section, .highlights, .pending-explanation, .ai-disclosure:not(.source-disclosure)')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Read official source', exact: true })).toHaveAttribute('href', entries[1].sourceUrl);
  await expect(page.locator('body')).not.toContainText(/[가-힣]/);
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Official sources and collection status' })).toContainText('07:00');
  await expect(page.getByRole('dialog')).not.toContainText(/[가-힣]/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Service updates, version/ }).click();
  await expect(page.getByRole('dialog', { name: 'Code Pulse updates' })).toContainText('Current version');
  await expect(page.getByRole('dialog')).not.toContainText(/[가-힣]/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to changes', exact: true }).click();
  await page.getByRole('button', { name: 'Subscribe via RSS', exact: true }).click();
  await expect(page.getByLabel('Feed URL', { exact: true })).toHaveValue('http://127.0.0.1:4173/feed.xml?lang=en');
  await page.getByLabel('Product to follow').selectOption('codex');
  expect(new URL(await page.getByLabel('Feed URL', { exact: true }).inputValue()).searchParams.get('product')).toBe('codex');
  expect(new URL(await page.getByLabel('Feed URL', { exact: true }).inputValue()).searchParams.get('lang')).toBe('en');
  await expect(page.getByRole('dialog')).not.toContainText(/[가-힣]/);
});

test('mobile English controls stay accessible and all content fits a 320px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  const toggle = page.locator('header').getByRole('button', { name: 'English', exact: true });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Select dates', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Find by date' })).toBeVisible();
  await page.getByLabel('Start date', { exact: true }).fill('2026-10-05');
  await page.getByLabel('End date', { exact: true }).fill('2026-10-07');
  await page.getByRole('button', { name: 'Apply dates' }).click();
  await page.getByTestId('entry-card').first().getByRole('link').click();
  await expect(page.locator('.full-change-item')).toHaveCount(56);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('English saved export resolves full details beyond the compact catalog', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('code-pulse-saved', JSON.stringify(['claude-latest', 'codex-security'])));
  await page.goto('/?lang=en&saved=1');
  await expect(page.getByTestId('entry-card')).toHaveCount(2);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Markdown' }).click();
  const download = await downloadEvent;
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain('# Code Pulse saved articles');
  expect(text.match(/^\d+\. /gm)).toHaveLength(112);
  expect(text).toContain('56. Removed orphan-session markers after shutdown.');
  expect(text).toContain('lang=en');
  expect(text).toContain(entries[1].sourceUrl);
  expect(text).not.toMatch(/[가-힣]|Why it matters|AI commentary/);
});

test('English loading failures offer a retry and preserve unavailable source status wording', async ({ page }) => {
  let fail = true;
  await page.route('**/content/en/feed.json', route => fail
    ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
    : route.fulfill({ json: { ...feed, language: 'en', entries: details('en'), stale: true,
      sources: feed.sources.map(source => ({ ...source, state: 'error', checkedAt: undefined, lastSuccessAt: undefined })),
      latestRun: { ...feed.latestRun, status: 'failed', failedSources: ['kiro'] } } }));
  await page.goto('/?lang=en');
  await expect(page.getByRole('alert')).toContainText('Could not load changes');
  await expect(page.locator('body')).not.toContainText(/[가-힣]/);
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Data status' })).toContainText('Could not check any sources');
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Not checked yet');
  await expect(page.getByRole('dialog')).not.toContainText(/[가-힣]/);
});
