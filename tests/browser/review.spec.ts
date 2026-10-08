import { expect, test } from '@playwright/test';
import { feed, mockApi } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('review: first collection waits without claiming any previous data is stale', async ({ page }) => {
  await page.route('**/api/feed', route => route.fulfill({
    json: {
      ...feed,
      entries: [],
      stale: true,
      latestRun: undefined,
      sources: feed.sources.map(({ id, product, name, url }) => ({
        id, product, name, url, state: 'pending', entryCount: 0,
      })),
    },
  }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '첫 출처 확인 대기', exact: true })).toBeVisible();
  await expect(page.getByTestId('entry-card')).toHaveCount(0);
  await expect(page.getByRole('status', { name: '자료 상태' })).not.toContainText('마지막 확인 이후 시간이 지났습니다');
  await page.getByRole('button', { name: '출처 안내', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('확인 대기', { exact: true })).toHaveCount(3);
});

test('review: a new pending source does not age successful checks from today', async ({ page }) => {
  await page.route('**/api/feed', route => route.fulfill({
    json: {
      ...feed,
      entries: feed.entries.filter(entry => entry.product !== 'kiro'),
      stale: true,
      latestRun: undefined,
      sources: feed.sources.map(source => source.product !== 'kiro' ? source : {
        id: source.id, product: source.product, name: source.name, url: source.url,
        state: 'pending', entryCount: 0,
      }),
    },
  }));
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(3);
  await expect(page.getByRole('status', { name: '자료 상태' })).not.toContainText('마지막 확인 이후 시간이 지났습니다');
  await expect(page.getByRole('button', { name: '일부 출처 확인 대기', exact: true })).toBeVisible();
});

test('review: an initial failed collection does not claim previously collected stories exist', async ({ page }) => {
  await page.route('**/api/feed', route => route.fulfill({
    json: {
      ...feed,
      entries: [],
      stale: true,
      latestRun: { ...feed.latestRun, status: 'failed', failedSources: feed.sources.map(source => source.id) },
      sources: feed.sources.map(({ id, product, name, url }) => ({
        id, product, name, url, state: 'error', entryCount: 0, checkedAt: feed.generatedAt,
      })),
    },
  }));
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(0);
  const status = page.getByRole('status', { name: '자료 상태' });
  await expect(status).toContainText('모든 출처를 확인하지 못했습니다');
  await expect(status).not.toContainText('마지막 확인 이후 시간이 지났습니다');
  await expect(status).not.toContainText('이전에 확인한 글을 보여드립니다');
});

test('review: a stale cached snapshot with recent success has an unavailable-status explanation', async ({ page }) => {
  await page.route('**/api/feed', route => route.fulfill({ json: { ...feed, stale: true } }));
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
  const status = page.getByRole('status', { name: '자료 상태' });
  await expect(status).not.toContainText('마지막 확인 이후 시간이 지났습니다');
  await expect(status).toContainText('최신 수집 상태를 확인하지 못했습니다');
});

test('review: Home returns to the page heading instead of restoring the old list position', async ({ page }) => {
  await page.goto('/');
  const older = page.getByTestId('entry-card').last().getByRole('link', { name: 'Claude Code 2.0.9', exact: true });
  await older.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await older.click();
  await expect(page.getByRole('article', { name: 'Claude Code 2.0.9' })).toBeVisible();
  await page.getByRole('link', { name: 'Code Pulse 홈', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('heading', { name: /코딩 도구의 변화/ })).toBeFocused();
});

test('review: each successful save announces the result after an identical toast expires', async ({ page }) => {
  await page.goto('/');
  const savedNotice = page.getByRole('status').filter({ hasText: '글을 저장했습니다.' });
  await page.getByTestId('entry-card').nth(0).getByRole('button', { name: '글 저장', exact: true }).click();
  await expect(savedNotice).toBeVisible();
  await expect(savedNotice).toBeHidden({ timeout: 7000 });
  await page.getByTestId('entry-card').nth(1).getByRole('button', { name: '글 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('code-pulse-saved') ?? '[]')))
    .toEqual(['claude-latest', 'codex-security']);
  await expect(savedNotice).toBeVisible();
});

test('review: a range spanning years displays both years without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '날짜 선택', exact: true }).click();
  await page.getByLabel('시작일').fill('2025-10-05');
  await page.getByLabel('종료일').fill('2026-10-06');
  await page.getByRole('button', { name: '날짜 적용', exact: true }).click();
  await expect(page.getByTestId('entry-card')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '날짜 선택', exact: true })).toContainText('2025.10.05 ~ 2026.10.06');
  await expect(page.getByLabel('선택한 필터', { exact: true })).toContainText('2025.10.05 ~ 2026.10.06');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/code-pulse-mobile-year-range.png', fullPage: true });
});

for (const [query, expected] of [
  ['from=2025-10-05', '2025.10.05 ~ 최근'],
  ['to=2025-10-06', '처음 ~ 2025.10.06'],
] as const) {
  test(`review: an open-ended range retains its year (${query})`, async ({ page }) => {
    await page.goto(`/?${query}`);
    await expect(page.getByRole('button', { name: '날짜 선택', exact: true })).toContainText(expected);
    await expect(page.getByLabel('선택한 필터', { exact: true })).toContainText(expected);
  });
}

test('review: failed explanations in a partial run do not imply official sources failed', async ({ page }) => {
  await page.route('**/api/feed', route => route.fulfill({
    json: {
      ...feed,
      latestRun: { ...feed.latestRun, status: 'partial', failedSources: [] },
    },
  }));
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
  await expect(page.getByTestId('entry-card').last().getByText('해설 준비 중', { exact: true })).toBeVisible();
  const status = page.getByRole('status', { name: '자료 상태' });
  await expect(status).toContainText('일부 글은 아직 한국어 해설이 없습니다');
  await expect(status).not.toContainText('일부 출처를 확인하지 못했습니다');
  await page.getByRole('button', { name: '출처 안내', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('확인 완료', { exact: true })).toHaveCount(3);
});

test('review: editorial completion clears warnings even when the last run remains partial', async ({ page }) => {
  await page.route('**/api/feed', route => route.fulfill({
    json: {
      ...feed,
      entries: feed.entries.filter(entry => entry.explanationStatus === 'ready'),
      latestRun: { ...feed.latestRun, status: 'partial', failedSources: [] },
    },
  }));
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(3);
  await expect(page.getByRole('status', { name: '자료 상태' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /공식 출처 확인 완료/ })).toBeVisible();
});

test('review: current pending explanations are shown even when the last run succeeded', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('entry-card')).toHaveCount(4);
  const status = page.getByRole('status', { name: '자료 상태' });
  await expect(status).toContainText('일부 글은 아직 한국어 해설이 없습니다');
  await expect(status).not.toContainText('일부 출처를 확인하지 못했습니다');
});
