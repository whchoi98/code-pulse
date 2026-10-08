import { expect, test } from '@playwright/test';
import { entries, mockApi } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('official product images load from this site in both themes', async ({ page }) => {
  await page.goto('/');
  const filterImages = page.getByRole('group', { name: '제품 필터' }).locator('img');
  await expect(filterImages).toHaveCount(3);
  const loadedLocally = () => page.locator('.product-mark img').evaluateAll(images =>
    images.length > 0 && images.every(image => {
      const logo = image as HTMLImageElement;
      return logo.complete && logo.naturalWidth > 0 && logo.naturalHeight > 0
        && new URL(logo.currentSrc).origin === window.location.origin;
    }),
  );
  await expect.poll(loadedLocally).toBe(true);
  await expect(filterImages.nth(0)).toBeVisible();
  await expect(filterImages.nth(1)).toBeVisible();
  await expect(filterImages.nth(2)).toBeVisible();
  await page.getByRole('button', { name: '다크 모드로 전환' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(loadedLocally).toBe(true);
  await page.screenshot({ path: '/tmp/code-pulse-official-logos-dark.png', fullPage: true });
});

test('Claude Code official product news and changelog links remain usable', async ({ page }) => {
  await page.route('**/api/entries/claude-latest', route => route.fulfill({
    json: {
      ...entries[1],
      sourceUrl: 'https://code.claude.com/docs/ko/whats-new',
      references: [{
        title: 'Claude Code changelog',
        url: 'https://code.claude.com/docs/en/changelog',
        kind: 'changelog',
      }],
    },
  }));
  await page.goto('/?entry=claude-latest');
  await expect(page.getByRole('link', { name: '공식 원문 읽기', exact: true }))
    .toHaveAttribute('href', 'https://code.claude.com/docs/ko/whats-new');
  await expect(page.getByRole('link', { name: /Claude Code changelog/ }))
    .toHaveAttribute('href', 'https://code.claude.com/docs/en/changelog');
});
