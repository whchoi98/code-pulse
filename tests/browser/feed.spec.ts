import { expect, test } from '@playwright/test';
import { entries, feed, mockApi } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('orders the feed by publication date, independently of collection time', async ({ page }) => {
  await page.goto('/');
  const cards = page.getByTestId('entry-card');
  await expect(cards).toHaveCount(4);
  await expect.poll(() => cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-entry-id'))))
    .toEqual(['claude-latest', 'codex-security', 'kiro-day', 'claude-older']);
  await expect(cards.nth(2).locator('time')).toHaveAttribute('datetime', '2026-10-05');
  await expect(cards.last().getByText('해설 준비 중', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/code-pulse-desktop.png', fullPage: true });
});

test('product and category filters change the actual visible entries', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('group', { name: '제품 필터' }).getByRole('button', { name: 'Codex', exact: false }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(page.getByTestId('entry-card')).toHaveAttribute('data-entry-id', 'codex-security');
  await page.getByRole('group', { name: '제품 필터' }).getByRole('button', { name: '전체', exact: false }).click();
  await page.getByLabel('변경 종류').selectOption('fix');
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(page.getByTestId('entry-card')).toHaveAttribute('data-entry-id', 'kiro-day');
});

test('searches content and recovers from an empty result', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('searchbox', { name: '변경 기록 검색' }).fill('디렉터리');
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(page.getByTestId('entry-card')).toHaveAttribute('data-entry-id', 'codex-security');
  await page.getByRole('searchbox', { name: '변경 기록 검색' }).fill('일치하지 않는 검색어');
  await expect(page.getByTestId('entry-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '필터 초기화', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
});

test('selects a real product-day from the activity table and supports date ranges', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Kiro 2026-10-05 발표 1건' }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(page.getByTestId('entry-card')).toHaveAttribute('data-entry-id', 'kiro-day');
  await page.getByRole('button', { name: '선택한 필터 모두 지우기' }).click();
  await page.getByRole('button', { name: '날짜 선택', exact: true }).click();
  await page.getByLabel('시작일').fill('2026-10-05');
  await page.getByLabel('종료일').fill('2026-10-06');
  await page.getByRole('button', { name: '날짜 적용', exact: true }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(2);
  await expect(page.getByTestId('entry-card').first()).toHaveAttribute('data-entry-id', 'codex-security');
});

test('saved entries survive reload and can be removed from the saved view', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('entry-card').first().getByRole('button', { name: '글 저장', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /저장한 글 보기/ }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(page.getByTestId('entry-card')).toHaveAttribute('data-entry-id', 'claude-latest');
  await page.getByTestId('entry-card').getByRole('button', { name: '저장 해제', exact: true }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '전체 글 보기', exact: true })).toBeVisible();
});

test('entry links load the detail endpoint and preserve browser back navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('entry-card').first().getByRole('link', { name: entries[1].explanation!.title, exact: true }).click();
  await expect(page).toHaveURL(/\?entry=claude-latest/);
  await expect(page.getByRole('article', { name: entries[1].explanation!.title })).toBeVisible();
  await expect(page.getByText(entries[1].explanation!.highlights[0].evidence, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('AI 해설', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '공식 원문 읽기' })).toHaveAttribute('href', entries[1].sourceUrl);
  await page.goBack();
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
});

test('shared day-precision details never invent a publication time', async ({ page }) => {
  await page.goto('/?entry=kiro-day');
  await expect(page.getByRole('article', { name: entries[0].explanation!.title })).toBeVisible();
  await expect(page.getByTestId('publication-date')).toHaveText('2026.10.05');
  await expect(page.getByTestId('publication-date')).toHaveAttribute('datetime', '2026-10-05');
  await expect(page.getByText(/시각을 제공하지/)).toBeVisible();
});

test('failed feed can be retried without treating the error as an empty feed', async ({ page }) => {
  let failed = true;
  await page.route('**/api/feed', route => failed
    ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
    : route.fulfill({ json: feed }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('불러오지 못했습니다');
  await expect(page.getByTestId('entry-card')).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
});

test('partial failures and stale data remain visible beside existing entries', async ({ page }) => {
  await page.route('**/api/feed', route => route.fulfill({
    json: {
      ...feed,
      stale: true,
      sources: feed.sources.map(source => source.product === 'kiro'
        ? { ...source, state: 'error', checkedAt: '2026-10-07T00:10:00Z', lastSuccessAt: '2026-10-04T00:10:00Z', error: 'timeout' }
        : source),
      latestRun: { ...feed.latestRun, status: 'partial', failedSources: ['kiro'] },
    },
  }));
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
  await expect(page.getByRole('status', { name: '자료 상태' })).toContainText('마지막 확인 이후 시간이 지났습니다');
  await expect(page.getByRole('status', { name: '자료 상태' })).toContainText('일부 출처');
  await page.getByRole('button', { name: '출처 안내', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '공식 출처와 수집 상태' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('확인 실패', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('2026.10.04 09:10', { exact: false })).toBeVisible();
});

test('source dialog traps keyboard focus and Escape returns focus to its trigger', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '출처 안내', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '공식 출처와 수집 상태' });
  await expect(dialog).toBeVisible();
  await dialog.screenshot({ path: '/tmp/code-pulse-sources.png' });
  for (let index = 0; index < 9; index += 1) {
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('390px mobile supports filters, details, and dark mode without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
  const hasNoOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await expect.poll(hasNoOverflow).toBe(true);
  await page.screenshot({ path: '/tmp/code-pulse-mobile-feed.png', fullPage: true });
  await page.getByRole('button', { name: '다크 모드로 전환' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('entry-card').first().getByRole('link', { name: entries[1].explanation!.title, exact: true }).click();
  await expect(page.getByRole('article', { name: entries[1].explanation!.title })).toBeVisible();
  await expect.poll(hasNoOverflow).toBe(true);
  await page.screenshot({ path: '/tmp/code-pulse-mobile.png', fullPage: true });
});

test('an unknown shared entry shows a recovery action without breaking the page', async ({ page }) => {
  await page.goto('/?entry=unknown');
  await expect(page.getByRole('alert')).toContainText('글을 찾을 수 없습니다');
  await page.getByRole('button', { name: '목록으로 돌아가기', exact: true }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
});

test('shows the full Korean calendar date when a timestamp crosses midnight', async ({ page }) => {
  await page.route('**/api/entries/claude-latest', route => route.fulfill({
    json: { ...entries[1], publishedAt: '2026-10-06T17:30:00Z', publishedDate: '2026-10-06' },
  }));
  await page.goto('/?entry=claude-latest');
  await expect(page.getByTestId('publication-date')).toHaveText('2026.10.06');
  await expect(page.getByText('한국 시간 2026.10.07 02:30', { exact: true })).toBeVisible();
});

test('a healthy empty feed differs from an unavailable feed and pending collection', async ({ page }) => {
  await page.route('**/api/feed', route => route.fulfill({ json: { ...feed, entries: [], latestRun: { ...feed.latestRun, newEntries: 0 } } }));
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('공식 출처를 확인했습니다.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '수집 상태 확인' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('shows loading while waiting for the feed and never inserts sample stories', async ({ page }) => {
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/feed', async route => { await hold; await route.fulfill({ json: feed }); });
  await page.goto('/');
  await expect(page.getByRole('status', { name: '불러오는 중' })).toBeVisible();
  await expect(page.getByTestId('entry-card')).toHaveCount(0);
  release();
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
});

test('keyboard search and opening a filtered result return to the same list', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: '변경 기록 검색' })).toBeFocused();
  await page.keyboard.type('Codex');
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  const link = page.getByTestId('entry-card').getByRole('link', { name: entries[2].explanation!.title, exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: entries[2].explanation!.title })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('searchbox', { name: '변경 기록 검색' })).toHaveValue('Codex');
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
  await expect(link).toBeFocused();
});

test('copies a canonical entry link without personal search filters', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?q=workspace&saved=1&entry=claude-latest');
  await page.getByRole('button', { name: '글 주소 복사', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('http://127.0.0.1:4173/?entry=claude-latest&lang=ko');
});

test('saving still works within the current tab when browser storage is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Unavailable', 'QuotaExceededError'); };
  });
  await page.goto('/');
  await page.getByTestId('entry-card').first().getByRole('button', { name: '글 저장', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '브라우저에 저장하지 못했습니다.' })).toBeVisible();
  await page.getByRole('button', { name: /저장한 글 보기/ }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(1);
});

test('returning from a detail keeps older entries revealed by load more', async ({ page }) => {
  const extraEntries = Array.from({ length: 21 }, (_, index) => ({
    ...feed.entries[0],
    id: `additional-${index.toString().padStart(2, '0')}`,
    publishedDate: '2026-10-04',
    publishedAt: '2026-10-04',
  }));
  await page.route('**/api/feed', route => route.fulfill({ json: { ...feed, entries: [...feed.entries, ...extraEntries] } }));
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(20);
  await page.getByRole('button', { name: /변경 기록 더 보기/ }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(25);
  const link = page.getByTestId('entry-card').last().getByRole('link', { name: 'Claude Code 2.0.9', exact: true });
  await link.click();
  await expect(page.getByRole('article', { name: 'Claude Code 2.0.9' })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('entry-card')).toHaveCount(25);
  await expect(link).toBeFocused();
});
